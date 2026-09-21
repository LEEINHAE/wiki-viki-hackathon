import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

test(
	'list review and batch publication with real PostgreSQL',
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
					name: 'batch-review-test',
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
			const reset = async () => {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
			};
			async function seed(
				title,
				{
					content = '## 안내\n\n업무 내용을 확인합니다.',
					status = 'review',
					governance = {},
					aliases = []
				} = {}
			) {
				const [row] =
					await sql`INSERT INTO drafts (title,slug,content,status,governance,aliases,source_name,editor_handle)
				VALUES (${title},${title},${content},${status},${JSON.stringify(governance)},${JSON.stringify(aliases)},'batch-review.xlsx','Editor-07') RETURNING id`;
				return String(row.id);
			}
			const list = (query = '') => load({ url: new URL('http://localhost/drafts' + query) });
			async function tokens(ids) {
				const data = await list();
				return ids.map((id) => `${id}:${data.drafts.find((d) => String(d.id) === id).version}`);
			}
			function post(selection, confirmed = 'yes') {
				const body = new FormData();
				selection.forEach((token) => body.append('draft', token));
				if (confirmed) body.set('confirmPublish', confirmed);
				return actions.publishBatch({
					request: new Request('http://localhost/drafts', { method: 'POST', body })
				});
			}
			async function counts() {
				return (
					await sql`SELECT (SELECT count(*)::int FROM documents) AS documents,
				(SELECT count(*)::int FROM revisions) AS revisions, (SELECT count(*)::int FROM redirects) AS redirects`
				)[0];
			}
			function mockAI(st, respond = () => ({ passed: true, reasons: [] })) {
				const calls = [];
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					const body = JSON.parse(options.body);
					calls.push(body);
					const value = await respond(body);
					return Response.json({
						object: 'response',
						status: 'completed',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: JSON.stringify(value) }]
							}
						]
					});
				});
				return calls;
			}
			await t.test(
				'saved content, aliases, source, links and unique anchors are available directly in the list',
				async () => {
					await reset();
					const a = await seed('검토하나', {
						content:
							'## 안내\n\n[[검토둘]] [^a]\n\n[^a]: 근거\n\n![설명](https://example.invalid/image.png)\n<script>alert(1)</script>',
						aliases: ['첫별칭']
					});
					const b = await seed('검토둘', {
						content: '## 안내\n\n[문단](#section-1) [^a]\n\n[^a]: 다른 근거'
					});
					const data = await list();
					const first = data.reviewList.items.find((d) => String(d.id) === a);
					const second = data.reviewList.items.find((d) => String(d.id) === b);
					assert.ok(first.previewHtml.includes(`/drafts?open=${b}`));
					assert.ok(first.previewHtml.includes(`id="draft-${a}-section-1"`));
					assert.ok(first.previewHtml.includes(`href="#draft-${a}-fn-a"`));
					assert.ok(second.previewHtml.includes(`href="#draft-${b}-section-1"`));
					assert.ok(!first.previewHtml.includes('<img') && !first.previewHtml.includes('<script>'));
					assert.equal(first.source_name, 'batch-review.xlsx');
					assert.deepEqual(first.aliases, ['첫별칭']);
					assert.deepEqual(await counts(), { documents: 0, revisions: 0, redirects: 0 });
				}
			);
			await t.test(
				'filtering and pagination render at most 20 saved drafts without losing other draft data',
				async () => {
					await reset();
					for (let i = 0; i < 22; i++)
						await seed(`목록${i}`, { status: i === 0 ? 'blocked' : 'review' });
					const data = await list();
					assert.equal(data.drafts.length, 22);
					assert.equal(data.reviewList.items.length, 20);
					assert.equal((await list('?page=2')).reviewList.items.length, 2);
					assert.equal((await list('?page=Infinity')).reviewList.page, 1);
					assert.equal((await list('?status=blocked')).reviewList.total, 1);
					assert.equal((await list('?status=review&page=999')).reviewList.items.length, 1);
				}
			);
			await t.test(
				'publishes selected versions only, keeps BIGINT IDs and metadata, retries without duplicates',
				async (st) => {
					await reset();
					const calls = mockAI(st);
					const small = await seed('게시하나', {
						aliases: ['별칭하나'],
						governance: { seed: { source: 'preserved' } }
					});
					await sql`UPDATE drafts SET id=9007199254740993 WHERE id=${small}`;
					const a = '9007199254740993',
						b = await seed('게시둘', { aliases: ['별칭둘'] }),
						c = await seed('남길초안');
					const selection = await tokens([a, b]);
					assert.deepEqual(
						(await post(selection)).results.map((r) => r.outcome),
						['published', 'published']
					);
					assert.deepEqual(await counts(), { documents: 2, revisions: 2, redirects: 2 });
					assert.equal((await sql`SELECT status FROM drafts WHERE id=${c}`)[0].status, 'review');
					const [saved] = await sql`SELECT * FROM drafts WHERE id=${a}`;
					assert.deepEqual(saved.governance.seed, { source: 'preserved' });
					assert.equal(saved.governance.semantic.skipped, true);
					assert.equal(saved.source_name, 'batch-review.xlsx');
					assert.deepEqual(
						(await post(selection)).results.map((r) => r.outcome),
						['alreadyPublished', 'alreadyPublished']
					);
					assert.deepEqual(await counts(), { documents: 2, revisions: 2, redirects: 2 });
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'eight selections complete in input order with at most four concurrent AI inspections',
				async (st) => {
					await reset();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					let active = 0,
						peak = 0;
					const calls = mockAI(st, async () => {
						active++;
						peak = Math.max(peak, active);
						if (active === 4) ready.resolve();
						await release.promise;
						active--;
						return { passed: true, reasons: [] };
					});
					const ids = [];
					for (let i = 0; i < 8; i++) ids.push(await seed(`묶음${i}`));
					const pending = post(await tokens(ids));
					await ready.promise;
					assert.equal(calls.length, 4);
					release.resolve();
					const result = await pending;
					assert.deepEqual(
						result.results.map((r) => r.id),
						ids
					);
					assert.ok(result.results.every((r) => r.outcome === 'published'));
					assert.equal(calls.length, 8);
					assert.equal(peak, 4);
					assert.deepEqual(await counts(), { documents: 8, revisions: 8, redirects: 0 });
				}
			);
			await t.test(
				'invalid, duplicate, excessive and unconfirmed selections fail before any write or AI call',
				async (st) => {
					await reset();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const calls = mockAI(st);
					const [token] = await tokens([await seed('입력검증')]);
					for (const [selection, confirmed] of [
						[[], 'yes'],
						[[token], ''],
						[[token, token], 'yes'],
						[Array(9).fill(token), 'yes'],
						[['1:bad'], 'yes'],
						[[token + ':extra'], 'yes'],
						[[`9223372036854775808:${'a'.repeat(64)}`], 'yes']
					])
						assert.equal((await post(selection, confirmed)).status, 400);
					assert.deepEqual(await counts(), { documents: 0, revisions: 0, redirects: 0 });
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'a conflicting item stays intact while another publishes; an unchanged retry is safe',
				async () => {
					await reset();
					const a = await seed('충돌자료'),
						b = await seed('정상자료');
					const [existing] =
						await sql`INSERT INTO documents (title,slug,content) VALUES ('충돌자료','충돌자료','기존 본문 보존') RETURNING *`;
					const selection = await tokens([a, b]);
					const result = await post(selection);
					assert.equal(result.results[0].status, 409);
					assert.equal(result.results[1].outcome, 'published');
					assert.deepEqual(
						(await sql`SELECT * FROM documents WHERE id=${existing.id}`)[0],
						existing
					);
					assert.equal((await sql`SELECT status FROM drafts WHERE id=${a}`)[0].status, 'review');
					assert.deepEqual(
						(await post(selection)).results.map((r) => r.outcome),
						['failed', 'alreadyPublished']
					);
				}
			);
			await t.test(
				'blocked and merge-proposal drafts cannot bypass individual review, including forged checkbox posts',
				async (st) => {
					await reset();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const calls = mockAI(st);
					const a = await seed('차단자료', { status: 'blocked' }),
						b = await seed('통합자료', { governance: { merge: { id: 'preserve-proposal' } } });
					const result = await post(await tokens([a, b]));
					assert.ok(result.results.every((r) => r.status === 400));
					assert.equal(calls.length, 0);
					assert.equal(
						(await sql`SELECT governance FROM drafts WHERE id=${b}`)[0].governance.merge.id,
						'preserve-proposal'
					);
					assert.deepEqual(await counts(), { documents: 0, revisions: 0, redirects: 0 });
				}
			);
			await t.test(
				'sensitive content never reaches AI, while safe items independently pass inspection',
				async (st) => {
					await reset();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const calls = mockAI(st);
					const a = await seed('보호자료', { content: 'password=NotARealSecret42!' }),
						b = await seed('안전자료');
					const result = await post(await tokens([a, b]));
					assert.equal(result.results[0].status, 400);
					assert.equal(result.results[1].outcome, 'published');
					assert.equal(calls.length, 1);
					assert.ok(!JSON.stringify(calls).includes('NotARealSecret42'));
					assert.equal((await sql`SELECT status FROM drafts WHERE id=${a}`)[0].status, 'blocked');
				}
			);
			await t.test(
				'an unavailable AI inspection does not mark an item published or prevent other outcomes',
				async (st) => {
					await reset();
					state.env.OPENAI_API_KEY = 'test-only-key';
					mockAI(st, (body) => ({
						passed: JSON.stringify(body).includes('장애자료') ? 'invalid' : true,
						reasons: []
					}));
					const a = await seed('장애자료'),
						b = await seed('통과자료');
					const result = await post(await tokens([a, b]));
					assert.equal(result.results[0].status, 503);
					assert.equal(result.results[1].outcome, 'published');
					assert.equal((await sql`SELECT status FROM drafts WHERE id=${a}`)[0].status, 'blocked');
				}
			);
			await t.test(
				'edits during inspection and stale/deleted selections cannot publish unreviewed content',
				async (st) => {
					await reset();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const started = Promise.withResolvers(),
						release = Promise.withResolvers();
					mockAI(st, async () => {
						started.resolve();
						await release.promise;
						return { passed: true, reasons: [] };
					});
					const a = await seed('변경자료'),
						b = await seed('삭제자료');
					const selection = await tokens([a, b]);
					await sql`DELETE FROM drafts WHERE id=${b}`;
					const pending = post(selection);
					await started.promise;
					await sql`UPDATE drafts SET content='다른 검토자가 바꾼 내용' WHERE id=${a}`;
					release.resolve();
					const result = await pending;
					assert.equal(result.results[0].status, 409);
					assert.equal(result.results[1].status, 404);
					assert.equal(
						(await sql`SELECT content FROM drafts WHERE id=${a}`)[0].content,
						'다른 검토자가 바꾼 내용'
					);
					assert.deepEqual(await counts(), { documents: 0, revisions: 0, redirects: 0 });
				}
			);
			await t.test(
				'a mid-transaction failure rolls back that entire item; retry preserves successful items',
				async () => {
					await reset();
					const a = await seed('실패자료', { content: '롤백 자료', aliases: ['실패별칭'] }),
						b = await seed('성공자료', { aliases: ['성공별칭'] });
					const selection = await tokens([a, b]);
					await sql.unsafe(
						`CREATE FUNCTION batch_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content='롤백 자료' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER batch_fail BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION batch_fail()`
					);
					try {
						const result = await post(selection);
						assert.equal(result.results[0].status, 503);
						assert.equal(result.results[1].outcome, 'published');
						assert.deepEqual(await counts(), { documents: 1, revisions: 1, redirects: 1 });
						assert.equal((await sql`SELECT status FROM drafts WHERE id=${a}`)[0].status, 'review');
					} finally {
						await sql.unsafe('DROP TRIGGER batch_fail ON revisions; DROP FUNCTION batch_fail()');
					}
					assert.deepEqual(
						(await post(selection)).results.map((r) => r.outcome),
						['published', 'alreadyPublished']
					);
					assert.deepEqual(await counts(), { documents: 2, revisions: 2, redirects: 2 });
				}
			);
			await t.test(
				'overlapping batches wait on real independent backends and publish each draft once',
				async () => {
					await reset();
					const a = await seed('동시하나'),
						b = await seed('동시둘');
					const selection = await tokens([a, b]);
					const locked = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
						locked.resolve();
						await release.promise;
					});
					gate.catch(locked.reject);
					let pending;
					try {
						await locked.promise;
						pending = [post(selection), post(selection)];
						const deadline = Date.now() + 4000;
						let waiting = 0;
						while (Date.now() < deadline) {
							waiting = (
								await sql`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE documents, redirects%'`
							)[0].n;
							if (waiting === 4) break;
							await delay(20);
						}
						assert.equal(waiting, 4);
					} finally {
						release.resolve();
						await gate;
					}
					const results = (await Promise.all(pending)).flatMap((r) => r.results);
					assert.equal(results.filter((r) => r.outcome === 'published').length, 2);
					assert.deepEqual(await counts(), { documents: 2, revisions: 2, redirects: 0 });
					assert.ok((await post(selection)).results.every((r) => r.outcome === 'alreadyPublished'));
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
