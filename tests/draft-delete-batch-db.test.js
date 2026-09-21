import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

test(
	'atomic batch deletion of reviewed draft versions with real PostgreSQL',
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
					name: 'draft-delete-test',
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
			const { actions, load } = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			let calls = 0;
			t.mock.method(globalThis, 'fetch', async () => {
				calls++;
				throw new Error('Deletion must not call external services');
			});
			const seed = async (title, status = 'review', governance = {}) =>
				(
					await sql`INSERT INTO drafts(title,slug,content,source_name,status,governance)
			VALUES (${title},${title},'원본 본문','original.xlsx',${status},${JSON.stringify(governance)}) RETURNING id`
				)[0].id;
			const list = () => load({ url: new URL('http://localhost/drafts') });
			const tokens = async (ids) => {
				const { drafts } = await list();
				return ids.map((id) => `${id}:${drafts.find((d) => String(d.id) === String(id)).version}`);
			};
			const post = (selection, confirm = 'yes') => {
				const body = new FormData();
				selection.forEach((v) => body.append('draft', v));
				if (confirm) body.set('confirmDelete', confirm);
				return actions.deleteBatch({
					request: new Request('http://localhost/drafts?/deleteBatch', { method: 'POST', body })
				});
			};
			const rows = async () => [...(await sql`SELECT * FROM drafts ORDER BY id`)];
			const waitForLocks = async (count) => {
				const until = Date.now() + 5000;
				let waiting = 0;
				while (Date.now() < until) {
					waiting = (
						await sql`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF d%'`
					)[0].n;
					if (waiting >= count) return;
					await delay(20);
				}
				assert.fail(`Expected ${count} delete requests waiting on database locks, got ${waiting}`);
			};
			await t.test(
				'deletes review, blocked and merge drafts together, preserving unselected and published data',
				async () => {
					await state.clearDatabase();
					const ids = [
						await seed('일반'),
						await seed('차단', 'blocked', { passed: false }),
						await seed('통합', 'review', { merge: { id: 'saved-proposal' } })
					];
					const keep = await seed('미선택'),
						published = await seed('게시됨', 'published');
					const [doc] =
						await sql`INSERT INTO documents(title,slug,content) VALUES ('게시문서','published','보존 본문') RETURNING id`;
					await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES (${doc.id},'이력','Editor-01')`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES ('alias','별칭',${doc.id})`;
					await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES (${doc.id},'토론','보존 의견','Editor-01')`;
					const relations = async () =>
						Promise.all(
							['documents', 'revisions', 'redirects', 'discussions'].map((table) =>
								sql.unsafe(`SELECT * FROM ${table} ORDER BY id`).then((r) => [...r])
							)
						);
					const before = await relations(),
						beforeDrafts = (await rows()).filter((d) =>
							[String(keep), String(published)].includes(String(d.id))
						);
					const selection = await tokens(ids);
					const result = await post(selection);
					assert.equal(result.action, 'deleteBatch');
					assert.deepEqual(
						result.deleted.map((d) => d.id),
						ids.map(String)
					);
					assert.deepEqual(await rows(), beforeDrafts);
					assert.deepEqual(await relations(), before);
					assert.equal((await post(selection)).status, 409);
					assert.deepEqual(await rows(), beforeDrafts);
				}
			);
			await t.test('twenty drafts and BIGINT IDs/snapshot numbers are not truncated', async () => {
				await state.clearDatabase();
				const ids = [];
				for (let i = 0; i < 20; i++) ids.push(await seed(`대량${i}`));
				await sql`UPDATE drafts SET id=9007199254740993,governance='{"originalNumber":9007199254740993}'::jsonb WHERE id=${ids[0]}`;
				ids[0] = '9007199254740993';
				const result = await post(await tokens(ids));
				assert.equal(result.deleted.length, 20);
				assert.equal(result.deleted[0].id, ids[0]);
				assert.equal((await rows()).length, 0);
			});
			await t.test(
				'empty, excessive, duplicate, malformed and unconfirmed requests preserve every row',
				async () => {
					await state.clearDatabase();
					const ids = [];
					for (let i = 0; i < 21; i++) ids.push(await seed(`검증${i}`));
					const all = await tokens(ids),
						before = await rows();
					for (const [selection, confirm] of [
						[[], 'yes'],
						[all, 'yes'],
						[[all[0], all[0]], 'yes'],
						[['0:' + 'a'.repeat(64)], 'yes'],
						[['9223372036854775808:' + 'a'.repeat(64)], 'yes'],
						[[ids[0] + ':bad'], 'yes'],
						[[all[0] + ':extra'], 'yes'],
						[[all[0]], ''],
						[[all[0]], 'no']
					]) {
						assert.equal((await post(selection, confirm)).status, 400);
						assert.deepEqual(await rows(), before);
					}
				}
			);
			for (const change of ['edit', 'published', 'missing'])
				await t.test(`one ${change} selection prevents deleting the whole batch`, async () => {
					await state.clearDatabase();
					const a = await seed('유지'),
						b = await seed('변경');
					const selection = await tokens([a, b]);
					if (change === 'edit') await sql`UPDATE drafts SET content='최신 본문' WHERE id=${b}`;
					else if (change === 'published')
						await sql`UPDATE drafts SET status='published' WHERE id=${b}`;
					else await sql`DELETE FROM drafts WHERE id=${b}`;
					const before = await rows();
					const result = await post(selection);
					assert.equal(result.status, 409);
					assert.deepEqual(result.data.selection, selection);
					assert.deepEqual(await rows(), before);
				});
			for (const failure of ['raise', 'skip'])
				await t.test(
					`${failure} during deletion rolls back every selected draft and allows retry`,
					async () => {
						await state.clearDatabase();
						const a = await seed('삭제하나'),
							b = await seed('삭제둘');
						const selection = await tokens([a, b]);
						const before = await rows();
						await sql.unsafe(
							`CREATE FUNCTION batch_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id=${b} THEN ${failure === 'raise' ? "RAISE EXCEPTION 'synthetic delete failure';" : 'RETURN NULL;'} END IF; RETURN OLD; END $$; CREATE TRIGGER batch_delete_failure BEFORE DELETE ON drafts FOR EACH ROW EXECUTE FUNCTION batch_delete_failure()`
						);
						try {
							assert.equal((await post(selection)).status, 503);
							assert.deepEqual(await rows(), before);
						} finally {
							await sql.unsafe(
								'DROP TRIGGER batch_delete_failure ON drafts; DROP FUNCTION batch_delete_failure()'
							);
						}
						assert.equal((await post(selection)).deleted.length, 2);
						assert.deepEqual(await rows(), []);
					}
				);
			for (const mutation of ['edit', 'publish'])
				await t.test(
					`rechecks all versions after waiting for a concurrent ${mutation}`,
					async () => {
						await state.clearDatabase();
						const a = await seed('먼저잠금'),
							b = await seed('편집중');
						const selection = await tokens([a, b]);
						const locked = Promise.withResolvers(),
							release = Promise.withResolvers();
						const gate = sql.begin(async (tx) => {
							if (mutation === 'edit')
								await tx`UPDATE drafts SET content='동시 편집' WHERE id=${b}`;
							else await tx`UPDATE drafts SET status='published' WHERE id=${b}`;
							locked.resolve();
							await release.promise;
						});
						gate.catch(locked.reject);
						let pending;
						try {
							await locked.promise;
							pending = post(selection);
							await waitForLocks(1);
						} finally {
							release.resolve();
							await gate;
						}
						assert.equal((await pending).status, 409);
						const after = await rows();
						assert.equal(after.length, 2);
						assert.equal(after[0].status, 'review');
						assert.equal(
							mutation === 'edit' ? after[1].content : after[1].status,
							mutation === 'edit' ? '동시 편집' : 'published'
						);
					}
				);
			await t.test(
				'overlapping reversed requests lock in one order and delete only once',
				async () => {
					await state.clearDatabase();
					const a = await seed('동시하나'),
						b = await seed('동시둘');
					const selection = await tokens([a, b]);
					const locked = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`SELECT id FROM drafts WHERE id=${a} FOR UPDATE`;
						locked.resolve();
						await release.promise;
					});
					gate.catch(locked.reject);
					let pending;
					try {
						await locked.promise;
						pending = [post(selection), post([...selection].reverse())];
						await waitForLocks(2);
					} finally {
						release.resolve();
						await gate;
					}
					const result = await Promise.all(pending);
					assert.equal(result.filter((r) => r.deleted?.length === 2).length, 1);
					assert.equal(result.filter((r) => r.status === 409).length, 1);
					assert.deepEqual(await rows(), []);
				}
			);
			assert.equal(calls, 0);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
