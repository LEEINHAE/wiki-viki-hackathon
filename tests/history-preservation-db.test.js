import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { seedAIResponse } from './fixtures/seed-source.js';

test(
	'reviewed rollback preservation with isolated PostgreSQL',
	{
		skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1',
		timeout: 60000
	},
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
					name: 'isolated-history-preservation',
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
			const sql = state.db(),
				history = await server.ssrLoadModule('/src/routes/history/[slug]/+page.server.js');
			const slug = '장비-점검';
			async function seed() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
				const [doc] =
					await sql`INSERT INTO documents(slug,title,content) VALUES (${slug},'장비 점검','현재 본문') RETURNING *`;
				const [old] =
					await sql`INSERT INTO revisions(document_id,content,editor_handle,created_at) VALUES (${doc.id},'이전 본문','Editor-01','2026-01-01') RETURNING *`;
				await sql`INSERT INTO revisions(document_id,content,editor_handle,created_at) VALUES (${doc.id},'현재 본문','Editor-02','2026-01-02')`;
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES ('legacy-route','옛 주소',${doc.id})`;
				await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES (${doc.id},'확인','보존 의견','Editor-01')`;
				return { doc, old };
			}
			const read = (route = slug, diff = '') =>
				history.load({
					params: { slug: route },
					url: new URL(`http://localhost/history?diff=${diff}`)
				});
			async function input(revision, route = slug) {
				const data = await read(route);
				return {
					revision: String(revision),
					documentId: String(data.document.id),
					version: data.version,
					revisionVersion: data.revisions.find((r) => String(r.id) === String(revision)).version
				};
			}
			async function post(fields, route = slug) {
				const body = new FormData();
				for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
				try {
					return await history.actions.rollback({
						params: { slug: route },
						request: new Request('http://localhost/history?/rollback', { method: 'POST', body })
					});
				} catch (error) {
					if (error.status === 303) return { status: 303, location: error.location };
					throw error;
				}
			}
			async function snapshot() {
				const [row] =
					await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) AS data`;
				return row.data;
			}
			async function waitForLocks(count, pattern) {
				const deadline = Date.now() + 4000;
				while (Date.now() < deadline) {
					const rows =
						await sql`SELECT pid FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND state='active' AND wait_event_type='Lock' AND query LIKE ${pattern}`;
					if (new Set(rows.map((r) => r.pid)).size === count) return;
					await delay(20);
				}
				assert.fail('Independent PostgreSQL backends did not reach the expected lock');
			}
			function blockAI(st, work = async () => {}) {
				state.env.OPENAI_API_KEY = 'test-only-key';
				const calls = [];
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					calls.push(JSON.parse(options.body));
					await work();
					return seedAIResponse({ passed: true, reasons: [] });
				});
				return calls;
			}

			await t.test(
				'reviewed rollback preserves relationships and rejects replay, including a no-op restore',
				async () => {
					const { doc, old } = await seed(),
						fields = await input(old.id, 'legacy-route'),
						before = await snapshot();
					assert.equal(
						(await post(fields, 'legacy-route')).location,
						'/wiki/' + encodeURIComponent(slug)
					);
					const saved = await snapshot();
					assert.equal(saved.documents[0].id, before.documents[0].id);
					assert.equal(saved.documents[0].content, old.content);
					assert.deepEqual(saved.aliases, before.aliases);
					assert.deepEqual(saved.discussions, before.discussions);
					assert.deepEqual(saved.revisions.slice(0, 2), before.revisions);
					assert.equal((await post(fields)).status, 409);
					assert.deepEqual(await snapshot(), saved);
					const again = await input(old.id);
					assert.equal((await post(again)).status, 303);
					const noop = await snapshot();
					assert.equal(noop.revisions.length, 4);
					assert.equal((await post(again)).status, 409);
					assert.deepEqual(await snapshot(), noop);
					assert.equal(noop.documents[0].id, Number(doc.id));
				}
			);
			for (const [name, change, status = 409] of [
				[
					'document body',
					async ({ doc }) => sql`UPDATE documents SET content='다른 본문' WHERE id=${doc.id}`
				],
				[
					'title',
					async ({ doc }) => sql`UPDATE documents SET title='바뀐 제목' WHERE id=${doc.id}`
				],
				[
					'microsecond timestamp',
					async ({ doc }) =>
						sql`UPDATE documents SET updated_at=updated_at+interval '1 microsecond' WHERE id=${doc.id}`
				],
				['alias label', async () => sql`UPDATE redirects SET alias_title='바뀐 이름'`],
				['alias removal', async () => sql`DELETE FROM redirects`],
				[
					'revision body',
					async ({ old }) => sql`UPDATE revisions SET content='바뀐 옛 본문' WHERE id=${old.id}`
				],
				[
					'revision metadata',
					async ({ old }) => sql`UPDATE revisions SET summary='새 요약' WHERE id=${old.id}`
				],
				[
					'revision deletion',
					async ({ old }) => sql`DELETE FROM revisions WHERE id=${old.id}`,
					404
				],
				[
					'document deletion',
					async ({ doc }) => sql`DELETE FROM documents WHERE id=${doc.id}`,
					404
				],
				[
					'same URL recreation',
					async ({ doc }) => {
						await sql`DELETE FROM documents WHERE id=${doc.id}`;
						await sql`INSERT INTO documents(slug,title,content) VALUES (${slug},'장비 점검','새 문서')`;
					}
				]
			])
				await t.test(`stale ${name} is rejected before external inspection`, async (st) => {
					const row = await seed(),
						fields = await input(row.old.id);
					await change(row);
					const before = await snapshot(),
						calls = blockAI(st);
					const result = await post(fields);
					assert.equal(result.status, status);
					assert.equal(result.data.refreshRequired, true);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 0);
				});
			await t.test(
				'retargeted alias cannot restore a revision into another document',
				async (st) => {
					const { old } = await seed(),
						fields = await input(old.id, 'legacy-route');
					const [other] =
						await sql`INSERT INTO documents(slug,title,content) VALUES ('other','다른 문서','다른 본문') RETURNING *`;
					await sql`UPDATE redirects SET document_id=${other.id}`;
					const before = await snapshot(),
						calls = blockAI(st);
					assert.equal((await post(fields, 'legacy-route')).status, 409);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'missing, malformed or forged reviewed identities are rejected without AI',
				async (st) => {
					const { old } = await seed(),
						fields = await input(old.id),
						before = await snapshot(),
						calls = blockAI(st);
					for (const [key, value, status] of [
						['documentId', '', 400],
						['documentId', '9223372036854775808', 400],
						['documentId', '9999', 409],
						['version', '', 400],
						['version', 'z'.repeat(64), 400],
						['version', '0'.repeat(64), 409],
						['revisionVersion', '', 400],
						['revisionVersion', '0'.repeat(64), 409]
					])
						assert.equal((await post({ ...fields, [key]: value })).status, status);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'failed inspection preserves submitted versions when the native POST reloads newer data',
				async (st) => {
					const { doc, old } = await seed(),
						fields = await input(old.id);
					state.env.OPENAI_API_KEY = 'test-only-key';
					st.mock.method(globalThis, 'fetch', async () => {
						await sql`UPDATE documents SET content='검사 중 저장한 최신 본문' WHERE id=${doc.id}`;
						return seedAIResponse({ passed: false, reasons: ['검토 필요'] });
					});
					const result = await post(fields);
					assert.equal(result.status, 400);
					for (const key of Object.keys(fields)) assert.equal(result.data[key], fields[key]);
					const reloaded = await history.load({
						params: { slug },
						url: new URL('http://localhost/history'),
						request: new Request('http://localhost/history', { method: 'POST' })
					});
					assert.notEqual(reloaded.version, result.data.version);
					assert.equal((await sql`SELECT * FROM revisions`).length, 2);
				}
			);
			for (const mutation of ['update', 'delete'])
				await t.test(
					`source revision ${mutation} during inspection aborts the whole write`,
					async (st) => {
						const { old } = await seed(),
							fields = await input(old.id);
						let changed;
						const calls = blockAI(st, async () => {
							if (mutation === 'update')
								await sql`UPDATE revisions SET content='검사 중 변경' WHERE id=${old.id}`;
							else await sql`DELETE FROM revisions WHERE id=${old.id}`;
							changed = await snapshot();
						});
						assert.equal((await post(fields)).status, 409);
						assert.deepEqual(await snapshot(), changed);
						assert.equal(calls.length, 1);
					}
				);
			await t.test(
				'concurrent identical requests create exactly one revision on independent backends',
				async () => {
					const { old } = await seed(),
						fields = await input(old.id),
						before = await snapshot();
					const ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
						ready.resolve();
						await release.promise;
					});
					gate.catch(ready.reject);
					const pending = [];
					try {
						await ready.promise;
						pending.push(post(fields), post(fields));
						await waitForLocks(2, 'LOCK TABLE documents, redirects%');
					} finally {
						release.resolve();
						await Promise.all([gate, ...pending]);
					}
					const results = await Promise.all(pending);
					assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
					const after = await snapshot();
					assert.equal(after.revisions.length, before.revisions.length + 1);
					assert.deepEqual(after.aliases, before.aliases);
					assert.deepEqual(after.discussions, before.discussions);
				}
			);
			await t.test(
				'a source update committing while rollback waits on its row lock is rechecked',
				async () => {
					const { old } = await seed(),
						fields = await input(old.id),
						ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`UPDATE revisions SET content='잠금 뒤 바뀐 본문' WHERE id=${old.id}`;
						ready.resolve();
						await release.promise;
					});
					gate.catch(ready.reject);
					let pending;
					try {
						await ready.promise;
						pending = post(fields);
						await waitForLocks(1, '%WITH alias_input AS MATERIALIZED%');
					} finally {
						release.resolve();
						await Promise.all([gate, pending]);
					}
					assert.equal((await pending).status, 409);
					const after = await snapshot();
					assert.equal(after.documents[0].content, '현재 본문');
					assert.equal(after.revisions.length, 2);
					assert.equal(after.revisions[0].content, '잠금 뒤 바뀐 본문');
				}
			);
			await t.test(
				'BIGINT diff IDs remain distinct and invalid IDs do not invent a diff',
				async () => {
					const { doc } = await seed();
					await sql`DELETE FROM revisions`;
					await sql`INSERT INTO revisions(id,document_id,content,editor_handle,created_at) VALUES (9007199254740992,${doc.id},'이전','Editor-01','2026-01-01'),(9007199254740993,${doc.id},'다음','Editor-01','2026-01-01')`;
					const data = await read(slug, '9007199254740993');
					assert.equal(data.selected, '9007199254740993');
					assert.deepEqual(
						data.revisions.map((r) => String(r.id)),
						['9007199254740993', '9007199254740992']
					);
					assert.ok(data.changes.some((p) => p.removed && p.value === '이전'));
					assert.ok(data.changes.some((p) => p.added && p.value === '다음'));
					assert.equal((await read(slug, '9007199254740992')).selected, '9007199254740992');
					assert.deepEqual((await read(slug, '999')).changes, []);
				}
			);
			await t.test(
				'native POST load preserves safe action feedback when document or database is unavailable',
				async () => {
					await seed();
					await sql`DELETE FROM documents`;
					const event = {
						params: { slug },
						url: new URL('http://localhost/history'),
						request: new Request('http://localhost/history', { method: 'POST' })
					};
					assert.equal((await history.load(event)).missingDocument, true);
					await assert.rejects(read(), { status: 404 });
					await seed();
					await sql`ALTER TABLE revisions RENAME TO unavailable_history`;
					try {
						const result = await history.load(event);
						assert.equal(result.databaseError, true);
						assert.equal(result.document, null);
						assert.doesNotMatch(JSON.stringify(result), /unavailable_history|SELECT/);
						await assert.rejects(read(), { status: 503 });
					} finally {
						await sql`ALTER TABLE unavailable_history RENAME TO revisions`;
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
