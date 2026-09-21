import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test(
	'discussion governance with isolated PostgreSQL',
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
					name: 'isolated-discussion-database',
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
				'/src/routes/discussion/[slug]/+page.server.js'
			);
			const sql = state.db();
			const params = { slug: '장비-점검' };
			const values = {
				title: '  점검 주기 제안  ',
				body: '  점검 항목을 검토해 주세요.\r\n둘째 문단  ',
				editor: ' Operator-A '
			};
			async function seed() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = 'test-only-key';
				const [doc] =
					await sql`INSERT INTO documents (slug,title,content) VALUES ('장비-점검','장비 점검','참조 전용 원문') RETURNING *`;
				await sql`INSERT INTO revisions (document_id,content,editor_handle,summary) VALUES (${doc.id},'참조 전용 원문','Editor-01','최초 기록')`;
				await sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES ('설비-검사','설비 검사',${doc.id})`;
				await sql`INSERT INTO discussions (document_id,thread_title,body,editor_handle) VALUES (${doc.id},'기존 주제','기존 의견','Editor-01')`;
				return doc;
			}
			function request(input = values, slug = params.slug) {
				const form = new FormData();
				for (const [key, value] of Object.entries(input)) form.set(key, value);
				return {
					params: { slug },
					request: new Request('http://localhost/discussion/장비-점검', {
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
			function preserveInput(result, input) {
				for (const key of Object.keys(values)) assert.equal(result.data[key], input[key]);
			}
			function interceptAI(
				st,
				value = { passed: true, reasons: [] },
				status = 200,
				beforeResponse
			) {
				const calls = [];
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					calls.push(JSON.parse(options.body));
					await beforeResponse?.();
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
				'sensitive topics and bodies are blocked locally with exact input preservation',
				async (st) => {
					const calls = interceptAI(st);
					for (const [field, value] of [
						['title', '  900101-1000000 점검  '],
						['body', ' \r\n900101-1000000\r\n ']
					]) {
						await seed();
						const before = await snapshot();
						const input = { ...values, [field]: value };
						const result = await actions.default(request(input));
						assert.equal(result.status, 400);
						preserveInput(result, input);
						assert.ok(result.data.governance.fields.some((failure) => failure.field === field));
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'invalid required fields and handles keep every submitted value without AI or writes',
				async (st) => {
					const calls = interceptAI(st);
					for (const [field, value] of [
						['title', '  '],
						['body', ' \r\n '],
						['editor', ' invalid name ']
					]) {
						await seed();
						const before = await snapshot();
						const input = { ...values, [field]: value };
						const result = await actions.default(request(input));
						assert.equal(result.status, 400);
						preserveInput(result, input);
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'semantic rejection and outage preserve the submitted discussion and all existing records',
				async (st) => {
					for (const status of [200, 429]) {
						await st.test(String(status), async (nested) => {
							const calls = interceptAI(nested, { passed: false, reasons: ['검토 필요'] }, status);
							await seed();
							const before = await snapshot();
							const result = await actions.default(request());
							assert.equal(result.status, status === 200 ? 400 : 503);
							preserveInput(result, values);
							assert.equal(result.data.governance.semantic.skipped, false);
							if (status === 429) assert.equal(result.data.governance.semantic.unavailable, true);
							assert.deepEqual(await snapshot(), before);
							assert.equal(calls.length, 1);
						});
					}
				}
			);
			await t.test(
				'safe discussion via an alias inspects only submitted content and keeps existing relationships',
				async (st) => {
					const calls = interceptAI(st);
					const doc = await seed();
					const before = await snapshot();
					const result = await actions.default(request(values, '설비-검사'));
					assert.equal(result.success, true);
					assert.equal(result.semanticSkipped, false);
					assert.equal(result.title, '');
					assert.equal(result.body, '');
					assert.equal(result.editor, 'Operator-A');
					assert.equal(calls.length, 1);
					assert.equal(calls[0].input, `${values.title.trim()}\n${values.body.trim()}`);
					const after = await snapshot();
					assert.deepEqual(after.documents, before.documents);
					assert.deepEqual(after.revisions, before.revisions);
					assert.deepEqual(after.aliases, before.aliases);
					assert.deepEqual(after.discussions[0], before.discussions[0]);
					assert.equal(after.discussions.length, 2);
					assert.equal(after.discussions[1].document_id, doc.id);
					assert.equal(after.discussions[1].thread_title, values.title.trim());
					assert.equal(after.discussions[1].body, values.body.trim());
				}
			);
			await t.test(
				'keyless manual posting discloses skipped semantics and still blocks sensitive content',
				async (st) => {
					const calls = interceptAI(st);
					await seed();
					state.env.OPENAI_API_KEY = '';
					assert.equal((await load({ params })).semanticAvailable, false);
					const result = await actions.default(request());
					assert.equal(result.success, true);
					assert.equal(result.semanticSkipped, true);
					const before = await snapshot();
					const input = { ...values, body: 'password=NotARealSecret42!' };
					const blocked = await actions.default(request(input));
					assert.equal(blocked.status, 400);
					preserveInput(blocked, input);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'a missing document returns an actionable error with the input and no AI request',
				async (st) => {
					const calls = interceptAI(st);
					await seed();
					const before = await snapshot();
					const result = await actions.default(request(values, '없는-문서'));
					assert.equal(result.status, 404);
					assert.ok(result.data.message);
					preserveInput(result, values);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 0);
					await assert.rejects(load({ params: { slug: '없는-문서' } }), { status: 404 });
				}
			);
			await t.test(
				'database write errors preserve the input and hide internal details',
				async (st) => {
					interceptAI(st);
					await seed();
					const before = await snapshot();
					await sql.unsafe(
						"CREATE FUNCTION fail_discussion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-private-discussion-detail'; END $$"
					);
					await sql.unsafe(
						'CREATE TRIGGER fail_discussion BEFORE INSERT ON discussions FOR EACH ROW EXECUTE FUNCTION fail_discussion()'
					);
					try {
						const result = await actions.default(request());
						assert.equal(result.status, 500);
						assert.doesNotMatch(result.data.message, /test-private-discussion-detail/);
						preserveInput(result, values);
						assert.deepEqual(await snapshot(), before);
					} finally {
						await sql.unsafe('DROP TRIGGER fail_discussion ON discussions');
					}
				}
			);
			await t.test(
				'database read errors keep the input and expose a generic load state without AI',
				async (st) => {
					const calls = interceptAI(st);
					await seed();
					state.env.OPENAI_API_KEY = '';
					await sql.unsafe('ALTER TABLE documents RENAME TO temporarily_unavailable_documents');
					try {
						const result = await actions.default(request());
						assert.equal(result.status, 500);
						preserveInput(result, values);
						assert.doesNotMatch(result.data.message, /relation|documents|SELECT/i);
						const data = await load({ params });
						assert.equal(data.semanticAvailable, false);
						assert.equal(data.document, null);
						assert.equal(data.threads, null);
						assert.doesNotMatch(data.databaseError, /relation|documents|SELECT/i);
						assert.match(data.databaseError, /불러오지 못했습니다/);
						assert.equal(calls.length, 0);
					} finally {
						await sql.unsafe('ALTER TABLE temporarily_unavailable_documents RENAME TO documents');
					}
				}
			);
			await t.test(
				'deleting the document during inspection cannot create an orphan discussion',
				async (st) => {
					const doc = await seed();
					const calls = interceptAI(st, { passed: true, reasons: [] }, 200, async () => {
						await sql`DELETE FROM documents WHERE id=${doc.id}`;
					});
					const result = await actions.default(request());
					assert.equal(result.status, 409);
					preserveInput(result, values);
					assert.doesNotMatch(result.data.message, /foreign key|constraint|document_id/i);
					assert.equal((await sql`SELECT * FROM documents`).length, 0);
					assert.equal((await sql`SELECT * FROM discussions`).length, 0);
					assert.equal(calls.length, 1);
					const data = await load({
						params,
						request: new Request('http://localhost/discussion/장비-점검', { method: 'POST' })
					});
					assert.equal(data.document, null);
					assert.equal(data.threads, null);
					assert.match(data.databaseError, /문서를 찾을 수 없습니다/);
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
