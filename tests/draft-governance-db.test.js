import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const enabled = process.env.RUN_GOVERNANCE_DB_TESTS === '1';

test('draft governance with isolated PostgreSQL', { skip: !enabled }, async (t) => {
	const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
	const fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
	const server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, ws: false, watch: null },
		resolve: { alias: { $lib: lib } },
		plugins: [
			{
				name: 'isolated-governance-database',
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
		const { actions, load } = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
		const sql = state.db();
		const normal = {
			title: '장비 점검',
			content: '장비 상태를 확인합니다.',
			aliases: ['Equipment, Inspection']
		};
		async function seed(overrides = {}) {
			await state.clearDatabase();
			state.env.OPENAI_API_KEY = 'test-only-key';
			const draft = { ...normal, ...overrides };
			const [row] =
				await sql`INSERT INTO drafts (title,slug,content,aliases,editor_handle) VALUES (${draft.title},'장비-점검',${draft.content},${JSON.stringify(draft.aliases)},'Editor-01') RETURNING *`;
			return row;
		}
		function input(fields) {
			const body = new FormData();
			for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
			return { request: new Request('http://localhost/drafts', { method: 'POST', body }) };
		}
		async function publish(id) {
			const data = await load({ url: new URL(`http://localhost/drafts?open=${id}`) });
			return actions.publish(input({ id, version: data.selected?.version || '' }));
		}
		async function edit(id, changes = {}) {
			const data = await load({ url: new URL(`http://localhost/drafts?open=${id}`) });
			return input({
				id,
				version: data.selected?.version || '',
				title: normal.title,
				content: normal.content,
				editor: 'Editor-01',
				...changes
			});
		}
		function interceptAI(subtest, result = { passed: true, reasons: [] }, status = 200) {
			const calls = [];
			subtest.mock.method(globalThis, 'fetch', async (_url, options) => {
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
											{ type: 'output_text', text: JSON.stringify(result), annotations: [] }
										]
									}
								]
							}
						: { error: { message: 'Synthetic AI failure' } },
					{ status }
				);
			});
			return calls;
		}
		async function noPublication() {
			for (const table of ['documents', 'revisions', 'redirects']) {
				const [row] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM ${table}`);
				assert.equal(row.count, 0, `${table} must remain empty`);
			}
		}

		await t.test(
			'title, body and alias failures are saved as blocked without external transmission',
			async (st) => {
				const calls = interceptAI(st);
				for (const [field, value] of [
					['title', '900101-1000000 장비'],
					['content', 'password=NotARealSecret42!'],
					['aliases', '900101-1000000']
				]) {
					const draft = await seed();
					await assert.rejects(actions.update(await edit(draft.id, { [field]: value })), {
						status: 303
					});
					const [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
					assert.equal(saved.status, 'blocked');
					assert.equal(saved.governance.semantic.skipped, true);
					assert.ok(saved.governance.fields.some((item) => item.field === field));
					assert.deepEqual(saved[field], field === 'aliases' ? [value] : value);
					await noPublication();
				}
				assert.equal(calls.length, 0);
			}
		);

		await t.test(
			'publish rechecks every saved field and cannot be bypassed by review status',
			async (st) => {
				const calls = interceptAI(st);
				for (const changes of [
					{ title: '900101-1000000 장비' },
					{ content: 'password=NotARealSecret42!' },
					{ aliases: ['900101-1000000'] }
				]) {
					const draft = await seed(changes);
					const result = await publish(draft.id);
					assert.equal(result.status, 400);
					assert.equal(result.data.governance.passed, false);
					const [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
					assert.equal(saved.status, 'blocked');
					assert.deepEqual(saved.aliases, draft.aliases);
					await noPublication();
				}
				assert.equal(calls.length, 0);
			}
		);

		await t.test(
			'legacy edit submissions preserve aliases and semantic checks include all fields',
			async (st) => {
				const calls = interceptAI(st);
				const draft = await seed();
				await assert.rejects(actions.update(await edit(draft.id)), { status: 303 });
				const [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
				assert.deepEqual(saved.aliases, normal.aliases);
				assert.equal(saved.status, 'review');
				assert.equal(saved.governance.semantic.skipped, false);
				assert.equal(calls.length, 1);
				for (const field of [normal.title, normal.content, ...normal.aliases])
					assert.ok(calls[0].input.includes(field));
			}
		);

		await t.test(
			'corrected aliases and no-key manual review survive save and publication in the database',
			async (st) => {
				const calls = interceptAI(st);
				const draft = await seed({ aliases: ['900101-1000000'] });
				state.env.OPENAI_API_KEY = '';
				await assert.rejects(
					actions.update(await edit(draft.id, { aliases: 'Equipment, Inspection\n장비 확인' })),
					{ status: 303 }
				);
				let [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
				assert.equal(saved.status, 'review');
				assert.deepEqual(saved.aliases, ['Equipment, Inspection', '장비 확인']);
				assert.equal(saved.governance.semantic.skipped, true);
				await assert.rejects(publish(draft.id), { status: 303 });
				[saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
				assert.equal(saved.status, 'published');
				assert.equal(saved.governance.semantic.skipped, true);
				const [document] = await sql`SELECT * FROM documents`;
				const revisions = await sql`SELECT * FROM revisions WHERE document_id=${document.id}`;
				const aliases =
					await sql`SELECT alias_title FROM redirects WHERE document_id=${document.id} ORDER BY id`;
				assert.equal(document.content, normal.content);
				assert.equal(revisions.length, 1);
				assert.deepEqual(
					aliases.map((row) => row.alias_title),
					saved.aliases
				);
				assert.equal(calls.length, 0);
			}
		);

		await t.test('semantic rejection blocks publication even for locally safe text', async (st) => {
			const calls = interceptAI(st, { passed: false, reasons: ['검토 필요'] });
			const draft = await seed();
			const result = await publish(draft.id);
			assert.equal(result.status, 400);
			assert.equal(calls.length, 1);
			await noPublication();
		});

		await t.test(
			'semantic outage preserves edited text and blocks publication without retry loops',
			async (st) => {
				const calls = interceptAI(st, null, 429);
				const draft = await seed();
				await assert.rejects(
					actions.update(await edit(draft.id, { content: '수정한 작업 기록' })),
					{
						status: 303
					}
				);
				const [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
				assert.equal(saved.content, '수정한 작업 기록');
				assert.equal(saved.status, 'blocked');
				assert.equal(saved.governance.semantic.unavailable, true);
				assert.equal((await publish(draft.id)).status, 503);
				assert.equal(calls.length, 2);
				await noPublication();
			}
		);

		await t.test('invalid semantic results cannot authorize publication', async (st) => {
			const calls = interceptAI(st, { passed: 'true', reasons: [] });
			const draft = await seed();
			assert.equal((await publish(draft.id)).status, 503);
			assert.equal(calls.length, 1);
			await noPublication();
		});

		await t.test(
			'malformed stored aliases are preserved and blocked until explicitly corrected',
			async (st) => {
				const calls = interceptAI(st);
				const draft = await seed({ aliases: { invalid: true } });
				assert.equal((await publish(draft.id)).status, 400);
				await assert.rejects(actions.update(await edit(draft.id)), { status: 303 });
				const [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
				assert.deepEqual(saved.aliases, { invalid: true });
				assert.equal(saved.status, 'blocked');
				assert.equal(calls.length, 0);
				await noPublication();
			}
		);

		await t.test(
			'missing or published drafts are rejected before external inspection',
			async (st) => {
				const calls = interceptAI(st);
				const draft = await seed();
				const reviewed = await edit(draft.id);
				await sql`UPDATE drafts SET status='published' WHERE id=${draft.id}`;
				assert.equal((await actions.update(reviewed)).status, 409);
				assert.equal(
					(await actions.update(await edit(99999, { version: 'a'.repeat(64) }))).status,
					409
				);
				assert.equal((await publish(draft.id)).status, 409);
				assert.equal((await publish(99999)).status, 404);
				assert.equal(calls.length, 0);
			}
		);
	} finally {
		await state.closeDatabase();
		await server.close();
	}
});
