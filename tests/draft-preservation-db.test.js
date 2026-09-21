import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';

test(
	'draft edits and deletion preserve reviewed versions with PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1', timeout: 60000 },
	async (t) => {
		const lib = fileURLToPath(new URL('../src/lib', import.meta.url)),
			fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
		const server = await createServer({
			configFile: false,
			envDir: false,
			server: { middlewareMode: true, ws: false, watch: null },
			resolve: { alias: { $lib: lib } },
			plugins: [
				{
					name: 'isolated-draft-edits',
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
			await state.setupDatabase({ maxConnections: 8 });
			const sql = state.db();
			const { load, actions } = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			async function seed() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
				const [draft] =
					await sql`INSERT INTO drafts(title,slug,content,aliases,source_name,governance,created_at,updated_at)
				VALUES('장비 점검','장비-점검','원래 초안 본문\n\n둘째 문단','["장비, 점검","기존 별칭"]','자료.docx','{"seed":{"source":"preserve"},"custom":{"kept":true},"merge":{"id":"old-proposal"}}','2026-09-20 01:02:03.123456+00','2026-09-20 01:02:03.123456+00') RETURNING *`;
				await sql`INSERT INTO documents(slug,title,content) VALUES('existing','기존 게시 문서','유지할 문서')`;
				return draft;
			}
			async function snapshot() {
				const [row] =
					await sql`SELECT jsonb_build_object('drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r)) AS data`;
				return row.data;
			}
			async function fields(id) {
				const data = await load({ url: new URL('http://localhost/drafts?open=' + id) });
				const d = data.selected;
				return {
					id: String(id),
					version: d?.version || '',
					title: d?.title || '',
					content: d?.content || '',
					aliases: d?.aliases.join('\n') || '',
					editor: d?.editor_handle || '',
					confirmDelete: 'yes'
				};
			}
			async function post(action, fields) {
				const body = new FormData();
				for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, String(v));
				try {
					return await actions[action]({
						request: new Request('http://localhost/drafts', { method: 'POST', body })
					});
				} catch (result) {
					if (result.status === 303) return result;
					throw result;
				}
			}
			function kept(result, input) {
				for (const key of ['id', 'version', 'title', 'content', 'aliases', 'editor'])
					if (input[key] !== undefined)
						assert.equal(
							result.data[key].replace(/\r\n/g, '\n'),
							input[key].replace(/\r\n/g, '\n'),
							key
						);
			}
			function ai(st, before = async () => {}, passed = true) {
				const calls = [];
				state.env.OPENAI_API_KEY = 'test-only-key';
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					calls.push(JSON.parse(options.body));
					await before();
					return Response.json({
						object: 'response',
						status: 'completed',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [
									{
										type: 'output_text',
										text: JSON.stringify({ passed, reasons: [] }),
										annotations: []
									}
								]
							}
						]
					});
				});
				return calls;
			}
			async function lockedRequests(inputs) {
				const ready = Promise.withResolvers(),
					release = Promise.withResolvers();
				let holder;
				const holding = sql.begin(async (tx) => {
					[holder] = await tx`SELECT pg_backend_pid() AS pid`;
					await tx`SELECT id FROM drafts FOR UPDATE`;
					ready.resolve();
					await release.promise;
				});
				holding.catch(ready.reject);
				const pending = [];
				try {
					await ready.promise;
					for (const [action, input] of inputs) pending.push(post(action, input));
					const deadline = Date.now() + 5000;
					let found = false;
					while (Date.now() < deadline) {
						const rows =
							await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=current_schema() AND pid<>${holder.pid} AND state='active' AND wait_event_type='Lock'`;
						if (rows.length === inputs.length) {
							assert.equal(new Set(rows.map((r) => r.pid)).size, inputs.length);
							found = true;
							break;
						}
						await delay(20);
					}
					assert.ok(found, 'independent mutation requests must really overlap in PostgreSQL');
				} finally {
					release.resolve();
					await holding;
				}
				return Promise.all(pending);
			}
			await t.test(
				'update preserves ID, source, creation time and metadata while invalidating only the old proposal',
				async () => {
					const d = await seed(),
						before = await snapshot(),
						input = {
							...(await fields(d.id)),
							title: '수정한 장비 점검',
							content: '검토한 본문',
							editor: 'Editor-42',
							aliases: '장비, 점검\n새 별칭'
						};
					assert.equal((await post('update', input)).status, 303);
					const after = await snapshot(),
						saved = after.drafts[0];
					assert.equal(saved.id, before.drafts[0].id);
					assert.equal(saved.source_name, before.drafts[0].source_name);
					assert.equal(saved.created_at, before.drafts[0].created_at);
					assert.deepEqual(saved.governance.seed, before.drafts[0].governance.seed);
					assert.deepEqual(saved.governance.custom, before.drafts[0].governance.custom);
					assert.equal(saved.governance.merge, undefined);
					assert.equal(saved.governance.semantic.skipped, true);
					assert.equal(saved.content, input.content);
					assert.equal(saved.editor_handle, input.editor);
					assert.deepEqual(saved.aliases, ['장비, 점검', '새 별칭']);
					assert.deepEqual(after.documents, before.documents);
					assert.equal(after.revisions, null);
					const repeat = await post('update', input);
					assert.equal(repeat.status, 409);
					kept(repeat, input);
					assert.deepEqual(await snapshot(), after);
				}
			);
			await t.test(
				'confirmed deletion removes only the reviewed unpublished draft and replay is rejected',
				async () => {
					const d = await seed();
					await sql`INSERT INTO drafts(title,slug,content,status) VALUES('이미 게시한 초안','published','보존','published')`;
					const input = await fields(d.id),
						before = await snapshot();
					assert.equal((await post('delete', input)).status, 303);
					const after = await snapshot();
					assert.equal(after.drafts.length, 1);
					assert.deepEqual(after.drafts[0], before.drafts[1]);
					assert.deepEqual(after.documents, before.documents);
					const repeated = await post('delete', input);
					assert.equal(repeated.status, 409);
					kept(repeated, input);
					assert.deepEqual(await snapshot(), after);
				}
			);
			for (const action of ['update', 'delete'])
				for (const invalid of [
					{ id: '90071992547409920000' },
					{ id: '1.5' },
					{ id: '-1' },
					{ version: '' },
					{ version: 'old' }
				])
					await t.test(
						`${action} rejects malformed ${Object.keys(invalid)[0]} before AI without losing input`,
						async (st) => {
							const d = await seed(),
								calls = ai(st),
								input = { ...(await fields(d.id)), ...invalid, content: '보존할 입력' },
								before = await snapshot();
							const r = await post(action, input);
							assert.equal(r.status, 400);
							kept(r, input);
							assert.equal(calls.length, 0);
							assert.deepEqual(await snapshot(), before);
						}
					);
			await t.test('deletion requires server confirmation even without JavaScript', async (st) => {
				const d = await seed(),
					calls = ai(st),
					input = { ...(await fields(d.id)), content: '미저장 내용', confirmDelete: undefined },
					before = await snapshot();
				const r = await post('delete', input);
				assert.equal(r.status, 400);
				kept(r, input);
				assert.equal(calls.length, 0);
				assert.deepEqual(await snapshot(), before);
			});
			for (const invalid of [
				{ title: ' ' },
				{ content: ' ' },
				{ editor: 'personal-name' },
				{ title: '!!!' },
				{ content: '가'.repeat(200001) }
			])
				await t.test(
					`invalid update ${Object.keys(invalid)[0]} keeps the submitted fields`,
					async (st) => {
						const d = await seed(),
							calls = ai(st),
							input = { ...(await fields(d.id)), ...invalid },
							before = await snapshot();
						const r = await post('update', input);
						assert.equal(r.status, 400);
						kept(r, input);
						assert.equal(calls.length, 0);
						assert.deepEqual(await snapshot(), before);
					}
				);
			await t.test(
				'200000 characters save without truncation and blocked local fields never reach AI',
				async (st) => {
					const d = await seed();
					const input = { ...(await fields(d.id)), content: '가'.repeat(200000) };
					assert.equal((await post('update', input)).status, 303);
					assert.equal((await sql`SELECT length(content) AS size FROM drafts`)[0].size, 200000);
					const calls = ai(st),
						blockedInput = { ...(await fields(d.id)), content: '900101-1000000 점검 자료' };
					assert.equal((await post('update', blockedInput)).status, 303);
					assert.equal(calls.length, 0);
					const [saved] = await sql`SELECT * FROM drafts`;
					assert.equal(saved.status, 'blocked');
					assert.equal(saved.content, blockedInput.content);
					assert.deepEqual(saved.governance.custom, { kept: true });
				}
			);
			for (const action of ['update', 'delete'])
				for (const field of [
					'content',
					'aliases',
					'governance',
					'microsecond',
					'published',
					'deleted'
				])
					await t.test(`${action} rejects a stale ${field} before AI`, async (st) => {
						const d = await seed(),
							input = { ...(await fields(d.id)), content: '보존할 작성 중 본문' },
							calls = ai(st);
						if (field === 'deleted') await sql`DELETE FROM drafts`;
						else if (field === 'content') await sql`UPDATE drafts SET content='새 저장본'`;
						else if (field === 'aliases') await sql`UPDATE drafts SET aliases='["새 별칭"]'`;
						else if (field === 'governance')
							await sql`UPDATE drafts SET governance=governance || '{"changed":true}'::jsonb`;
						else if (field === 'published') await sql`UPDATE drafts SET status='published'`;
						else await sql`UPDATE drafts SET updated_at=updated_at+interval '1 microsecond'`;
						const before = await snapshot(),
							r = await post(action, input);
						assert.equal(r.status, 409);
						kept(r, input);
						assert.equal(calls.length, 0);
						assert.deepEqual(await snapshot(), before);
						assert.equal(
							!!r.data.conflict,
							action === 'update' && !['published', 'deleted'].includes(field)
						);
					});
			await t.test(
				'explicit comparison saves the submitted input, but another intervening edit needs another review',
				async () => {
					const d = await seed(),
						input = { ...(await fields(d.id)), content: '내가 쓰던 본문' };
					await sql`UPDATE drafts SET content='첫 동시 수정'`;
					const first = await post('update', input);
					assert.equal(first.status, 409);
					await sql`UPDATE drafts SET content='다음 동시 수정'`;
					const second = await post('update', {
						...input,
						resolveVersion: first.data.conflict.version
					});
					assert.equal(second.status, 409);
					assert.equal(second.data.content, input.content);
					assert.equal(second.data.conflict.content, '다음 동시 수정');
					assert.equal(
						(await post('update', { ...input, resolveVersion: second.data.conflict.version }))
							.status,
						303
					);
					assert.equal((await sql`SELECT content FROM drafts`)[0].content, input.content);
				}
			);
			for (const change of ['edit', 'delete', 'publish'])
				await t.test(`AI-inflight ${change} is detected at the database write`, async (st) => {
					const d = await seed(),
						input = { ...(await fields(d.id)), content: '검사 중인 입력' };
					let before;
					const calls = ai(st, async () => {
						if (change === 'delete') await sql`DELETE FROM drafts`;
						else if (change === 'publish') await sql`UPDATE drafts SET status='published'`;
						else await sql`UPDATE drafts SET content='검사 중 먼저 저장한 내용'`;
						before = await snapshot();
					});
					const r = await post('update', input);
					assert.equal(r.status, 409);
					kept(r, input);
					assert.equal(calls.length, 1);
					assert.deepEqual(await snapshot(), before);
				});
			for (const action of ['update', 'delete'])
				for (const skip of [false, true])
					await t.test(
						`${action} trigger ${skip ? 'skip' : 'exception'} rolls back and retry succeeds`,
						async () => {
							const d = await seed(),
								input = { ...(await fields(d.id)), content: '실패해도 보존할 내용' },
								before = await snapshot();
							await sql.unsafe(
								`CREATE FUNCTION reject_draft_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${skip ? 'RETURN NULL;' : "RAISE EXCEPTION 'test-private-draft-detail';"} END $$`
							);
							await sql.unsafe(
								`CREATE TRIGGER reject_draft_write BEFORE ${action === 'update' ? 'UPDATE' : 'DELETE'} ON drafts FOR EACH ROW EXECUTE FUNCTION reject_draft_write()`
							);
							try {
								const r = await post(action, input);
								assert.equal(r.status, 503);
								kept(r, input);
								assert.doesNotMatch(r.data.message, /test-private/);
								assert.deepEqual(await snapshot(), before);
							} finally {
								await sql`DROP TRIGGER reject_draft_write ON drafts`;
								await sql`DROP FUNCTION reject_draft_write()`;
							}
							assert.equal((await post(action, input)).status, 303);
						}
					);
			for (const other of ['update', 'delete', 'publish'])
				await t.test(
					`simultaneous update and ${other} on independent backends apply only one reviewed request`,
					async () => {
						const d = await seed(),
							input = await fields(d.id);
						const results = await lockedRequests([
							['update', { ...input, content: '동시 수정 본문' }],
							[other, input]
						]);
						assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
						const after = await snapshot();
						if (after.drafts?.[0]?.status === 'published') {
							assert.equal(after.documents.length, 2);
							assert.equal(after.revisions.length, 1);
						} else {
							assert.equal(after.documents.length, 1);
							assert.equal(after.revisions, null);
						}
					}
				);
			await t.test('two simultaneous deletions do not both report success', async () => {
				const d = await seed(),
					input = await fields(d.id);
				const results = await lockedRequests([
					['delete', input],
					['delete', input]
				]);
				assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
			});
			await t.test('adjacent BIGINT IDs are edited and deleted separately', async () => {
				await seed();
				await sql`DELETE FROM drafts`;
				await sql`INSERT INTO drafts(id,title,slug,content) VALUES(9007199254740992,'큰 초안 하나','large-a','첫 본문'),(9007199254740993,'큰 초안 둘','large-b','둘 본문')`;
				const a = await fields('9007199254740992'),
					b = await fields('9007199254740993');
				assert.equal((await post('update', { ...a, content: '첫 수정' })).status, 303);
				assert.equal((await post('delete', b)).status, 303);
				const [left] = await sql`SELECT * FROM drafts`;
				assert.equal(String(left.id), a.id);
				assert.equal(left.content, '첫 수정');
			});
			await t.test(
				'native publish with unsaved fields refuses and returns input before AI',
				async (st) => {
					const d = await seed(),
						calls = ai(st),
						input = { ...(await fields(d.id)), content: '아직 저장하지 않은 본문' },
						before = await snapshot();
					const r = await post('publish', input);
					assert.equal(r.status, 400);
					kept(r, input);
					assert.equal(calls.length, 0);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'unchanged native form can publish and keeps the existing publication transaction',
				async () => {
					const d = await seed();
					assert.equal((await post('publish', await fields(d.id))).status, 303);
					const after = await snapshot();
					assert.equal(after.drafts[0].status, 'published');
					assert.equal(after.documents.length, 2);
					assert.equal(after.revisions.length, 1);
				}
			);
			await t.test(
				'load and mutation database failures preserve input without claiming an empty list',
				async () => {
					const d = await seed(),
						input = await fields(d.id);
					await sql`ALTER TABLE drafts RENAME TO unavailable_drafts`;
					try {
						const data = await load({ url: new URL('http://localhost/drafts?open=' + d.id) });
						assert.ok(data.databaseError);
						for (const action of ['update', 'delete']) {
							const r = await post(action, input);
							assert.equal(r.status, 503);
							kept(r, input);
						}
					} finally {
						await sql`ALTER TABLE unavailable_drafts RENAME TO drafts`;
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
