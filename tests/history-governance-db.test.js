import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test(
	'rollback governance with isolated PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1' },
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
					name: 'isolated-history-database',
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
			await state.setupDatabase();
			const { actions, load } = await server.ssrLoadModule(
				'/src/routes/history/[slug]/+page.server.js'
			);
			const sql = state.db();
			const params = { slug: '장비-점검' };
			async function seed({
				title = '장비 점검',
				content = '복원할 점검 기록',
				alias = '설비 검사'
			} = {}) {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = 'test-only-key';
				const [doc] =
					await sql`INSERT INTO documents (slug,title,content) VALUES ('장비-점검',${title},'현재 점검 기록') RETURNING *`;
				const [old] =
					await sql`INSERT INTO revisions (document_id,content,editor_handle,summary,created_at) VALUES (${doc.id},${content},'Editor-01','처음 기록','2026-01-01') RETURNING *`;
				await sql`INSERT INTO revisions (document_id,content,editor_handle,summary,created_at) VALUES (${doc.id},'현재 점검 기록','Editor-02','최근 수정','2026-01-02')`;
				await sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES ('설비-검사',${alias},${doc.id})`;
				await sql`INSERT INTO discussions (document_id,thread_title,body,editor_handle) VALUES (${doc.id},'점검 주기','주기를 확인합니다.','Operator-A')`;
				return { doc, old };
			}
			async function request(revision, slug = params.slug) {
				let data;
				try {
					data = await load({ params: { slug }, url: new URL('http://localhost/history') });
				} catch {}
				const form = new FormData();
				form.set('documentId', data?.document.id || '1');
				form.set('version', data?.version || '0'.repeat(64));
				form.set(
					'revisionVersion',
					data?.revisions.find((r) => String(r.id) === String(revision))?.version || '0'.repeat(64)
				);
				form.set('revision', String(revision));
				return {
					params: { slug },
					request: new Request('http://localhost/history/장비-점검?/rollback', {
						method: 'POST',
						body: form
					})
				};
			}
			async function snapshot() {
				return {
					documents: [...(await sql`SELECT * FROM documents ORDER BY id`)],
					revisions: [...(await sql`SELECT * FROM revisions ORDER BY id`)],
					aliases: [...(await sql`SELECT * FROM redirects ORDER BY id`)],
					discussions: [...(await sql`SELECT * FROM discussions ORDER BY id`)]
				};
			}
			function interceptAI(st, value = { passed: true, reasons: [] }, status = 200) {
				const calls = [];
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					calls.push(JSON.parse(options.body));
					return Response.json(
						status === 200
							? {
									object: 'response',
									status: 'completed',
									output: [
										{
											type: 'message',
											role: 'assistant',
											content: [
												{ type: 'output_text', text: JSON.stringify(value), annotations: [] }
											]
										}
									]
								}
							: { error: { message: 'Synthetic outage' } },
						{ status }
					);
				});
				return calls;
			}

			await t.test(
				'sensitive restored content, current title and saved aliases block before any AI request',
				async (st) => {
					const calls = interceptAI(st);
					for (const [field, value] of [
						['title', '900101-1000000 장비'],
						['content', 'password=NotARealSecret42!'],
						['alias', '900101-1000000']
					]) {
						const { old } = await seed({ [field]: value });
						const before = await snapshot();
						const result = await actions.rollback(await request(old.id));
						assert.equal(result.status, 400);
						assert.equal(String(result.data.revision), String(old.id));
						assert.ok(
							result.data.governance.fields.some(
								(failure) => failure.field === (field === 'alias' ? 'aliases' : field)
							)
						);
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'semantic rejection and outage leave the document and all relationships unchanged',
				async (st) => {
					for (const status of [200, 429]) {
						await st.test(String(status), async (nested) => {
							const calls = interceptAI(nested, { passed: false, reasons: ['검토 필요'] }, status);
							const { old } = await seed();
							const before = await snapshot();
							const result = await actions.rollback(await request(old.id));
							assert.equal(result.status, status === 200 ? 400 : 503);
							assert.equal(result.data.governance.semantic.skipped, false);
							if (status === 429) assert.equal(result.data.governance.semantic.unavailable, true);
							assert.equal(String(result.data.revision), String(old.id));
							assert.deepEqual(await snapshot(), before);
							assert.equal(calls.length, 1);
						});
					}
				}
			);
			await t.test(
				'a safe rollback inspects the restored state and adds a revision while preserving prior history',
				async (st) => {
					const calls = interceptAI(st);
					const { doc, old } = await seed();
					const before = await snapshot();
					await assert.rejects(actions.rollback(await request(old.id)), {
						status: 303,
						location: '/wiki/' + encodeURIComponent(params.slug)
					});
					assert.equal(calls.length, 1);
					for (const text of [
						doc.title,
						old.content,
						'설비 검사',
						'선택한 리비전의 본문으로 되돌림'
					])
						assert.ok(calls[0].input.includes(text));
					assert.ok(!calls[0].input.includes('현재 점검 기록'));
					const after = await snapshot();
					assert.equal(after.documents[0].content, old.content);
					assert.equal(after.documents[0].title, doc.title);
					assert.equal(after.documents[0].slug, doc.slug);
					assert.equal(after.revisions.length, 3);
					assert.deepEqual(after.revisions.slice(0, 2), before.revisions);
					assert.equal(after.revisions[2].summary, `리비전 ${old.id}(으)로 되돌림`);
					assert.deepEqual(after.aliases, before.aliases);
					assert.deepEqual(after.discussions, before.discussions);
				}
			);
			for (const withKey of [false, true])
				await t.test(
					`numeric revision identity is preserved without being treated as contact text (key=${withKey})`,
					async (st) => {
						const { doc, old } = await seed(),
							revisionId = '1012345678',
							calls = interceptAI(st);
						await sql`UPDATE revisions SET id=${revisionId} WHERE id=${old.id}`;
						if (!withKey) state.env.OPENAI_API_KEY = '';
						await assert.rejects(actions.rollback(await request(revisionId)), { status: 303 });
						assert.equal(calls.length, withKey ? 1 : 0);
						if (withKey) {
							assert.ok(!calls[0].input.includes(revisionId));
							assert.ok(calls[0].input.includes(old.content));
						}
						assert.equal(
							(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
							old.content
						);
						assert.equal(
							(await sql`SELECT content FROM revisions WHERE id=${revisionId}`)[0].content,
							old.content
						);
						assert.equal(
							(
								await sql`SELECT id FROM revisions WHERE summary=${`리비전 ${revisionId}(으)로 되돌림`}`
							).length,
							1
						);
					}
				);
			await t.test(
				'missing key is disclosed without disabling safe manual rollback or local blocking',
				async (st) => {
					const calls = interceptAI(st);
					let { old } = await seed();
					state.env.OPENAI_API_KEY = '';
					const data = await load({
						params,
						url: new URL(`http://localhost/history/장비-점검?diff=${old.id}`)
					});
					assert.equal(data.semanticAvailable, false);
					assert.ok(data.changes.some((part) => part.added));
					await assert.rejects(actions.rollback(await request(old.id)), { status: 303 });
					({ old } = await seed({ content: 'password=NotARealSecret42! 변경 기록' }));
					state.env.OPENAI_API_KEY = '';
					const before = await snapshot();
					assert.equal((await actions.rollback(await request(old.id))).status, 400);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'foreign, missing and invalid revision IDs cannot trigger AI or change either document',
				async (st) => {
					const calls = interceptAI(st);
					const { old } = await seed();
					const [other] =
						await sql`INSERT INTO documents (slug,title,content) VALUES ('다른-문서','다른 문서','별도 본문') RETURNING *`;
					const [foreign] =
						await sql`INSERT INTO revisions (document_id,content,editor_handle) VALUES (${other.id},'다른 문서의 과거','Editor-02') RETURNING *`;
					const before = await snapshot();
					for (const [id, status] of [
						[foreign.id, 404],
						['999999', 404],
						['0', 400],
						['1e0', 400],
						['1.5', 400],
						['NaN', 400],
						['9223372036854775808', 400]
					]) {
						const result = await actions.rollback(await request(id));
						assert.equal(result.status, status);
						assert.ok(result.data.message);
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal((await actions.rollback(await request(old.id, '없는-문서'))).status, 404);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'database failure when inserting the rollback revision preserves the current document atomically',
				async (st) => {
					interceptAI(st);
					const { old } = await seed();
					const before = await snapshot();
					await sql.unsafe(
						"CREATE FUNCTION fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-private-history-detail'; END $$"
					);
					await sql.unsafe(
						'CREATE TRIGGER fail_revision BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION fail_revision()'
					);
					try {
						const result = await actions.rollback(await request(old.id));
						assert.equal(result.status, 500);
						assert.doesNotMatch(result.data.message, /test-private-history-detail/);
						assert.equal(String(result.data.revision), String(old.id));
						assert.deepEqual(await snapshot(), before);
					} finally {
						await sql.unsafe('DROP TRIGGER fail_revision ON revisions');
					}
				}
			);
			await t.test(
				'database read failures return a generic action error before any AI request',
				async (st) => {
					const calls = interceptAI(st);
					const { old } = await seed();
					const submitted = await request(old.id);
					await sql.unsafe('ALTER TABLE revisions RENAME TO temporarily_unavailable_revisions');
					try {
						const result = await actions.rollback(submitted);
						assert.equal(result.status, 500);
						assert.doesNotMatch(result.data.message, /relation|revisions|SELECT/i);
						assert.equal(calls.length, 0);
						await assert.rejects(
							load({ params, url: new URL('http://localhost/history/장비-점검') }),
							(error) => {
								assert.equal(error.status, 503);
								assert.doesNotMatch(error.body.message, /relation|revisions|SELECT/i);
								return true;
							}
						);
					} finally {
						await sql.unsafe('ALTER TABLE temporarily_unavailable_revisions RENAME TO revisions');
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
