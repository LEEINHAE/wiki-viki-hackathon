import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { seedAIResponse } from './fixtures/seed-source.js';

test(
	'direct edit preservation with isolated PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1', timeout: 60000 },
	async (t) => {
		const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
		const fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
		const server = await createServer({
			configFile: false,
			envDir: false,
			server: { middlewareMode: true, ws: false, watch: null },
			resolve: { alias: { $lib: lib } },
			plugins: [
				{
					name: 'isolated-edit-preservation',
					enforce: 'pre',
					resolveId(id) {
						if (id === '$env/dynamic/private' || id === `${lib}/server/db.js` || id === './db.js')
							return fixture;
					}
				}
			]
		});
		const state = await server.ssrLoadModule(fixture);
		try {
			await state.setupDatabase({ maxConnections: 6 });
			const sql = state.db();
			const edit = await server.ssrLoadModule('/src/routes/edit/[slug]/+page.server.js');
			const drafts = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			const history = await server.ssrLoadModule('/src/routes/history/[slug]/+page.server.js');
			const values = {
				title: '장비 점검',
				content: ' 내가 작성한 본문\r\n둘째 문단 ',
				aliases: '원래_이름\r\n쉼표, 별칭',
				aliasesFormat: 'lines',
				editor: 'Editor-02',
				summary: ' 보완 기록 '
			};
			async function reset() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
			}
			async function seed(slug = '장비-점검', title = '장비 점검') {
				const [doc] =
					await sql`INSERT INTO documents (slug,title,content) VALUES (${slug},${title},'기존 본문') RETURNING *`;
				const [revision] =
					await sql`INSERT INTO revisions (document_id,content,editor_handle,summary) VALUES (${doc.id},'기존 본문','Editor-01','처음 기록') RETURNING id`;
				await sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES ('원래-이름','원래 이름',${doc.id}),('이전-별칭','이전 별칭',${doc.id})`;
				await sql`INSERT INTO discussions (document_id,thread_title,body,editor_handle) VALUES (${doc.id},'토론','보존 의견','Editor-01')`;
				return { ...doc, revision: revision.id };
			}
			async function input(slug = '장비-점검', changes = {}) {
				const data = await edit.load({ params: { slug } });
				return {
					...values,
					version: data.version,
					documentId: data.document?.id || '',
					...changes
				};
			}
			async function post(fields, slug = '장비-점검', action = edit.actions.save) {
				if (action === history.actions.rollback) {
					const reviewed = await history.load({
						params: { slug },
						url: new URL('http://localhost/history')
					});
					fields = {
						...fields,
						documentId: reviewed.document.id,
						version: reviewed.version,
						revisionVersion: reviewed.revisions.find(
							(r) => String(r.id) === String(fields.revision)
						).version
					};
				}
				const body = new FormData();
				for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
				try {
					return await action({
						params: { slug },
						request: new Request('http://localhost/action', { method: 'POST', body })
					});
				} catch (error) {
					if (error.status === 303) return { status: 303, location: error.location };
					throw error;
				}
			}
			async function snapshot() {
				const [row] = await sql`SELECT jsonb_build_object(
			'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
			'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
			'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
			'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
			'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) AS data`;
				return row.data;
			}
			function preserved(result, submitted) {
				for (const key of Object.keys(values)) assert.equal(result.data[key], submitted[key]);
				assert.equal(result.data.version, submitted.version);
			}
			async function overlap(
				jobs,
				hold = (tx) => tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`
			) {
				const ready = Promise.withResolvers(),
					release = Promise.withResolvers();
				const gate = sql.begin(async (tx) => {
					await hold(tx);
					ready.resolve();
					await release.promise;
				});
				gate.catch(ready.reject);
				const pending = [];
				try {
					await ready.promise;
					for (const job of jobs) {
						const task = job();
						task.catch(() => {});
						pending.push(task);
					}
					const deadline = Date.now() + 4000;
					let waiting = false;
					while (Date.now() < deadline) {
						const rows =
							await sql`SELECT pid FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND state='active' AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE documents, redirects%'`;
						if (new Set(rows.map((r) => r.pid)).size === jobs.length) {
							waiting = true;
							break;
						}
						await delay(20);
					}
					assert.equal(waiting, true, 'independent PostgreSQL backends must wait on the held lock');
				} finally {
					release.resolve();
					await Promise.all([gate, ...pending]);
				}
				return Promise.all(pending);
			}
			await t.test(
				'editing through an alias preserves identity, URL, history and kept alias IDs while removing only omitted aliases',
				async () => {
					await reset();
					const doc = await seed();
					const before = await snapshot();
					const submitted = await input('원래-이름', { title: '새 장비 점검' });
					assert.equal(
						(await post(submitted, '원래-이름')).location,
						'/wiki/' + encodeURIComponent(doc.slug)
					);
					const after = await snapshot();
					assert.equal(after.documents[0].id, before.documents[0].id);
					assert.equal(after.documents[0].slug, doc.slug);
					assert.equal(after.documents[0].title, '새 장비 점검');
					assert.equal(after.documents[0].content, values.content);
					assert.deepEqual(after.revisions[0], before.revisions[0]);
					assert.equal(after.revisions.length, 2);
					assert.deepEqual(after.discussions, before.discussions);
					assert.equal(after.aliases[0].id, before.aliases[0].id);
					assert.equal(after.aliases[0].alias_title, '원래_이름');
					assert.deepEqual(
						after.aliases.map((r) => r.alias_title),
						['원래_이름', '쉼표, 별칭']
					);
					const reload = await edit.load({ params: { slug: doc.slug } });
					assert.equal(reload.aliases, '원래_이름\n쉼표, 별칭');
					const replay = await post(submitted, '원래-이름');
					assert.equal(replay.status, 409);
					preserved(replay, submitted);
					assert.deepEqual(await snapshot(), after);
				}
			);
			await t.test(
				'unchanged legacy alias URLs and duplicate labels retain every existing row',
				async () => {
					await reset();
					const doc = await seed();
					await sql`UPDATE redirects SET alias_title='같은 표시 이름' WHERE document_id=${doc.id}`;
					const before = await snapshot();
					const submitted = await input(undefined, { aliases: '같은 표시 이름\r\n같은 표시 이름' });
					assert.equal((await post(submitted)).status, 303);
					assert.deepEqual((await snapshot()).aliases, before.aliases);
				}
			);
			await t.test('safe rollback leaves legacy alias URLs and IDs intact', async () => {
				await reset();
				const doc = await seed();
				await sql`UPDATE redirects SET alias_title='이름은 바뀌었지만 주소는 유지' WHERE document_id=${doc.id}`;
				const before = await snapshot();
				assert.equal(
					(await post({ revision: doc.revision }, doc.slug, history.actions.rollback)).status,
					303
				);
				assert.deepEqual((await snapshot()).aliases, before.aliases);
			});
			await t.test(
				'an empty replacement list removes every alias and a missing version cannot mutate a document',
				async () => {
					await reset();
					await seed();
					const submitted = await input(undefined, { aliases: '' });
					const before = await snapshot();
					assert.equal((await post({ ...submitted, version: '' })).status, 400);
					assert.deepEqual(await snapshot(), before);
					assert.equal((await post(submitted)).status, 303);
					assert.equal((await snapshot()).aliases, null);
				}
			);
			await t.test(
				'new documents are inserted once without overwriting a subsequently occupied route',
				async () => {
					await reset();
					const submitted = await input();
					assert.equal(submitted.version, 'new');
					assert.equal((await post(submitted)).status, 303);
					const after = await snapshot();
					assert.equal(after.revisions.length, 1);
					assert.equal((await post(submitted)).status, 409);
					assert.deepEqual(await snapshot(), after);
				}
			);
			for (const kind of [
				'title',
				'title-route',
				'title-alias',
				'alias-route',
				'alias-alias',
				'alias-title',
				'title-alias-label',
				'alias-alias-label'
			])
				await t.test(
					`${kind} collisions preserve both documents and all related rows`,
					async () => {
						await reset();
						await seed();
						const [other] =
							await sql`INSERT INTO documents (slug,title,content) VALUES ('other','다른 문서','다른 본문') RETURNING id`;
						await sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES ('held','이미 사용 중',${other.id})`;
						const submitted = await input(
							undefined,
							kind === 'title'
								? { title: '다른 문서' }
								: kind === 'title-route'
									? { title: 'Other' }
									: kind === 'title-alias'
										? { title: 'held' }
										: kind === 'title-alias-label'
											? { title: '이미 사용 중' }
											: {
													aliases:
														kind === 'alias-title'
															? '다른 문서'
															: kind === 'alias-alias-label'
																? '이미 사용 중'
																: kind === 'alias-route'
																	? 'other'
																	: 'held'
												}
						);
						const before = await snapshot(),
							result = await post(submitted);
						assert.equal(result.status, 409);
						preserved(result, submitted);
						assert.deepEqual(await snapshot(), before);
					}
				);
			for (const creating of [false, true])
				for (const trashed of [false, true])
					await t.test(
						`legacy alias label is reserved for ${creating ? 'creation' : 'editing'}, including trash=${trashed}`,
						async () => {
							await reset();
							if (!creating) await seed();
							const [other] =
								await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('표기 소유자','label-owner','보존 본문',${trashed ? new Date() : null},${trashed ? 'Editor-01' : null}) RETURNING id`;
							await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('old-label-url','새로 입력한 이름',${other.id})`;
							const submitted = await input(undefined, { title: '새로 입력한 이름' }),
								before = await snapshot();
							const result = await post(submitted);
							assert.equal(result.status, 409);
							preserved(result, submitted);
							assert.deepEqual(await snapshot(), before);
							assert.equal(
								(await post({ ...submitted, title: '겹치지 않는 수정 제목' })).status,
								303
							);
						}
					);
			await t.test(
				'existing ambiguous labels and their legacy URLs remain editable without data cleanup',
				async () => {
					await reset();
					const doc = await seed();
					const [other] =
						await sql`INSERT INTO documents(title,slug,content) VALUES('다른 소유자','other-owner','보존 원문') RETURNING id`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('older-duplicate','원래 이름',${other.id})`;
					const submitted = await input(undefined, { aliases: '원래 이름\n이전 별칭' }),
						before = await snapshot();
					assert.equal((await post(submitted)).status, 303);
					const after = await snapshot();
					assert.deepEqual(after.aliases, before.aliases);
					assert.deepEqual(
						after.documents.find((d) => String(d.id) === String(other.id)),
						before.documents.find((d) => String(d.id) === String(other.id))
					);
					assert.equal(after.documents.find((d) => String(d.id) === String(doc.id)).slug, doc.slug);
				}
			);
			await t.test(
				'legacy whitespace trimming does not turn a retained ambiguous label into a new claim',
				async () => {
					await reset();
					await seed();
					await sql`UPDATE redirects SET alias_title=' 원래 이름 ' WHERE alias_slug='원래-이름'`;
					const [other] =
						await sql`INSERT INTO documents(title,slug,content) VALUES('별칭 소유자','other-label-owner','원문') RETURNING id`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('duplicate-old-label','원래 이름',${other.id})`;
					const before = await snapshot();
					const submitted = await input(undefined, { aliases: ' 원래 이름 \n이전 별칭' });
					assert.equal((await post(submitted)).status, 303);
					assert.deepEqual(
						(await snapshot()).aliases,
						before.aliases.map((a) =>
							a.alias_slug === '원래-이름' ? { ...a, alias_title: '원래 이름' } : a
						)
					);
				}
			);
			await t.test(
				'rollback preserves a legacy untrimmed title shared by an existing alias label',
				async () => {
					await reset();
					const doc = await seed('장비-점검', ' 장비 점검 ');
					const [other] =
						await sql`INSERT INTO documents(title,slug,content) VALUES('다른 제목 소유자','other-title-owner','보존 본문') RETURNING id`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('old-title-label',${doc.title},${other.id})`;
					const before = await snapshot();
					assert.equal(
						(await post({ revision: doc.revision }, doc.slug, history.actions.rollback)).status,
						303
					);
					const after = await snapshot();
					assert.deepEqual(after.aliases, before.aliases);
					assert.equal(after.documents[0].title, doc.title);
					assert.equal(after.documents[0].slug, doc.slug);
					assert.deepEqual(after.documents[1], before.documents[1]);
					assert.deepEqual(after.revisions[0], before.revisions[0]);
					assert.equal(after.revisions.length, before.revisions.length + 1);
				}
			);
			for (const rollback of [false, true])
				for (const archived of [false, true])
					for (const ownerRoute of ['canonical', 'alias']) {
						await t.test(
							`${rollback ? 'rollback' : 'body edit'} preserves a legacy title whose unused URL belongs to an ${archived ? 'archived' : 'active'} ${ownerRoute}`,
							async () => {
								await reset();
								const doc = await seed('legacy-equipment');
								await sql`UPDATE documents SET content='현재 보관 본문' WHERE id=${doc.id}`;
								const [other] = await sql`INSERT INTO documents(title,slug,content)
						VALUES ('별도 주소 소유자',${ownerRoute === 'canonical' ? '장비-점검' : 'other-owner'},'다른 문서의 보존 본문') RETURNING id`;
								if (ownerRoute === 'alias')
									await sql`INSERT INTO redirects(alias_slug,alias_title,document_id)
						VALUES ('장비-점검','다른 문서의 옛 별칭',${other.id})`;
								if (archived)
									await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-42',lifecycle_version=3 WHERE id=${other.id}`;
								await sql`INSERT INTO drafts(title,slug,content,status,governance)
						VALUES (${doc.title},${doc.slug},'보존할 게시 초안','published',${JSON.stringify({ published: { slug: doc.slug } })}::jsonb)`;
								const before = await snapshot();
								const submitted = await input(doc.slug, {
									title: doc.title,
									aliases: '원래 이름\r\n이전 별칭'
								});
								const result = rollback
									? await post({ revision: doc.revision }, doc.slug, history.actions.rollback)
									: await post(submitted, doc.slug);
								assert.equal(result.status, 303);
								assert.equal(result.location, '/wiki/' + doc.slug);
								const after = await snapshot();
								for (const key of ['aliases', 'discussions', 'drafts'])
									assert.deepEqual(after[key], before[key]);
								assert.deepEqual(after.documents[1], before.documents[1]);
								assert.deepEqual(
									after.revisions.slice(0, before.revisions.length),
									before.revisions
								);
								assert.equal(after.revisions.length, before.revisions.length + 1);
								const saved = after.documents[0];
								assert.equal(saved.id, before.documents[0].id);
								assert.equal(saved.slug, doc.slug);
								assert.equal(saved.title, doc.title);
								assert.equal(saved.content, rollback ? '기존 본문' : values.content);
								assert.equal(after.revisions.at(-1).content, saved.content);
								assert.equal(
									(await edit.load({ params: { slug: '원래-이름' } })).document.id,
									doc.id
								);
								// Existing labels introduce no URL. A genuinely new title or alias
								// must still be rejected when its derived/stored URL is already held.
								for (const changes of [
									{ title: '장비_점검' },
									{ aliases: '원래 이름\r\n이전 별칭\r\n장비 점검' }
								]) {
									const pending = await input(doc.slug, {
										title: doc.title,
										aliases: '원래 이름\r\n이전 별칭',
										...changes
									});
									const rejected = await post(pending, doc.slug);
									assert.equal(rejected.status, 409);
									preserved(rejected, pending);
									assert.deepEqual(await snapshot(), after);
								}
							}
						);
					}
			await t.test(
				'promoting an owned legacy alias to the title still checks the new title URL',
				async () => {
					await reset();
					const doc = await seed('legacy-equipment');
					await sql`UPDATE redirects SET alias_slug='legacy-name' WHERE alias_slug='원래-이름'`;
					await sql`INSERT INTO documents(title,slug,content) VALUES ('다른 주소 소유자','원래-이름','보존 본문')`;
					const before = await snapshot();
					const submitted = await input(doc.slug, {
						title: '원래 이름',
						aliases: '원래 이름\r\n이전 별칭'
					});
					const result = await post(submitted, doc.slug);
					assert.equal(result.status, 409);
					preserved(result, submitted);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'a renamed title and a published alias cannot concurrently claim the same label',
				async () => {
					await reset();
					await seed();
					const submitted = await input(undefined, { title: '공유 표시 이름', aliases: '' });
					const [draft] =
						await sql`INSERT INTO drafts(title,slug,content,aliases) VALUES('새 게시','new-publication','게시 본문','["공유 표시 이름"]') RETURNING id`;
					const data = await drafts.load({
						url: new URL('http://localhost/drafts?open=' + draft.id)
					});
					const results = await overlap([
						() => post(submitted),
						() =>
							post(
								{ id: draft.id, version: data.selected.version },
								'unused',
								drafts.actions.publish
							)
					]);
					assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
					const owners =
						await sql`SELECT id FROM documents WHERE title='공유 표시 이름' UNION SELECT document_id FROM redirects WHERE alias_title='공유 표시 이름'`;
					assert.equal(owners.length, 1);
				}
			);
			for (const [table, event] of [
				['documents', 'INSERT'],
				['documents', 'UPDATE'],
				['revisions', 'INSERT'],
				['redirects', 'INSERT'],
				['redirects', 'UPDATE'],
				['redirects', 'DELETE']
			])
				for (const behavior of ['raise', 'skip'])
					await t.test(
						`${table} ${event} ${behavior} rolls back the entire save and permits a safe retry`,
						async () => {
							await reset();
							if (!(table === 'documents' && event === 'INSERT')) await seed();
							const submitted = await input(),
								before = await snapshot();
							await sql.unsafe(
								`CREATE FUNCTION fail_edit_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${behavior === 'raise' ? "RAISE EXCEPTION 'test-private-edit-stage';" : 'RETURN NULL;'} END $$`
							);
							await sql.unsafe(
								`CREATE TRIGGER reject_edit_stage BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_edit_stage()`
							);
							try {
								const result = await post(submitted);
								assert.equal(result.status, 500);
								preserved(result, submitted);
								assert.doesNotMatch(JSON.stringify(result), /test-private|division by zero/);
								assert.deepEqual(await snapshot(), before);
							} finally {
								await sql.unsafe(`DROP TRIGGER reject_edit_stage ON ${table}`);
								await sql`DROP FUNCTION fail_edit_stage()`;
							}
							assert.equal((await post(submitted)).status, 303);
						}
					);
			await t.test(
				'stale microsecond versions stop before AI and comparison requires an explicit current version',
				async (st) => {
					await reset();
					const doc = await seed();
					const submitted = await input();
					await sql`UPDATE documents SET updated_at=updated_at+interval '1 microsecond',content='상대가 저장한 내용' WHERE id=${doc.id}`;
					const before = await snapshot();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const fetch = st.mock.method(globalThis, 'fetch', () => {
						throw new Error('unexpected AI');
					});
					const result = await post(submitted);
					assert.equal(result.status, 409);
					preserved(result, submitted);
					assert.equal(result.data.conflict.content, '상대가 저장한 내용');
					assert.equal(fetch.mock.callCount(), 0);
					assert.deepEqual(await snapshot(), before);
					state.env.OPENAI_API_KEY = '';
					assert.equal(
						(await post({ ...submitted, resolveVersion: result.data.conflict.version })).status,
						303
					);
					assert.equal((await snapshot()).documents[0].content, values.content);
				}
			);
			for (const change of ['body', 'aliases', 'delete-recreate'])
				await t.test(
					`${change} changes during AI inspection cannot be overwritten or resurrected`,
					async (st) => {
						await reset();
						const doc = await seed();
						const submitted = await input();
						state.env.OPENAI_API_KEY = 'test-only-key';
						let changed;
						st.mock.method(globalThis, 'fetch', async () => {
							if (change === 'body')
								await sql`UPDATE documents SET content='새로운 저장본' WHERE id=${doc.id}`;
							else if (change === 'aliases')
								await sql`UPDATE redirects SET alias_title='다른 별칭 표시' WHERE alias_slug='원래-이름'`;
							else {
								await sql`DELETE FROM documents WHERE id=${doc.id}`;
								await sql`INSERT INTO documents (slug,title,content) VALUES ('장비-점검','장비 점검','다시 만든 문서')`;
							}
							changed = await snapshot();
							return seedAIResponse({ passed: true, reasons: [] });
						});
						const result = await post(submitted);
						assert.equal(result.status, 409);
						preserved(result, submitted);
						assert.deepEqual(await snapshot(), changed);
					}
				);
			await t.test(
				'a removed or reassigned entry alias never switches the edit to another document',
				async () => {
					await reset();
					const original = await seed();
					const submitted = await input('원래-이름');
					const [other] =
						await sql`INSERT INTO documents (slug,title,content) VALUES ('other','다른 대상','보존할 다른 본문') RETURNING id`;
					await sql`UPDATE redirects SET document_id=${other.id} WHERE alias_slug='원래-이름'`;
					const before = await snapshot(),
						result = await post(submitted, '원래-이름');
					assert.equal(result.status, 409);
					assert.equal(result.data.conflict.slug, original.slug);
					assert.equal(
						(
							await post(
								{ ...submitted, resolveVersion: result.data.conflict.version },
								'원래-이름'
							)
						).status,
						409
					);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'concurrent saves from the same version have one winner and preserve the losing input',
				async () => {
					await reset();
					await seed();
					const a = await input(),
						b = { ...a, content: '두 번째 입력' };
					const results = await overlap([() => post(a), () => post(b)]);
					assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
					const loser = results.findIndex((r) => r.status === 409);
					preserved(results[loser], loser === 0 ? a : b);
					assert.equal((await snapshot()).revisions.length, 2);
				}
			);
			await t.test('two new documents with a shared alias cannot both claim it', async () => {
				await reset();
				const a = await input(),
					b = await input('other', { title: '다른 문서' });
				const results = await overlap([() => post(a), () => post(b, 'other')]);
				assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
				assert.equal((await snapshot()).documents.length, 1);
			});
			await t.test(
				'a direct save and draft publication use compatible locks and never steal the same alias',
				async () => {
					await reset();
					await seed();
					const submitted = await input();
					const [draft] =
						await sql`INSERT INTO drafts (title,slug,content,aliases) VALUES ('게시 초안','게시-초안','검토한 본문','["쉼표, 별칭"]'::jsonb) RETURNING id`;
					const data = await drafts.load({
						url: new URL(`http://localhost/drafts?open=${draft.id}`)
					});
					const results = await overlap([
						() => post(submitted),
						() =>
							post(
								{ id: draft.id, version: data.selected.version },
								'unused',
								drafts.actions.publish
							)
					]);
					assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
					const after = await snapshot();
					assert.equal(after.aliases.filter((r) => r.alias_slug === '쉼표-별칭').length, 1);
				}
			);
			await t.test(
				'an in-flight document change is observed after waiting for the write lock',
				async () => {
					await reset();
					const doc = await seed(),
						submitted = await input();
					const [result] = await overlap(
						[() => post(submitted)],
						(tx) => tx`UPDATE documents SET content='아직 커밋 전인 수정' WHERE id=${doc.id}`
					);
					assert.equal(result.status, 409);
					assert.equal((await snapshot()).documents[0].content, '아직 커밋 전인 수정');
				}
			);
			await t.test(
				'a rollback cannot bypass the shared snapshot guard during AI inspection',
				async (st) => {
					await reset();
					const doc = await seed();
					state.env.OPENAI_API_KEY = 'test-only-key';
					let changed;
					st.mock.method(globalThis, 'fetch', async () => {
						await sql`UPDATE documents SET content='되돌리기 검사 중 새 편집' WHERE id=${doc.id}`;
						changed = await snapshot();
						return seedAIResponse({ passed: true, reasons: [] });
					});
					assert.equal(
						(await post({ revision: doc.revision }, doc.slug, history.actions.rollback)).status,
						409
					);
					assert.deepEqual(await snapshot(), changed);
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
