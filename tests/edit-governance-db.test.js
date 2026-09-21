import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test(
	'direct edit governance with isolated PostgreSQL',
	{
		skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1'
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
					name: 'isolated-edit-database',
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
				'/src/routes/edit/[slug]/+page.server.js'
			);
			const sql = state.db();
			const values = {
				title: '장비 점검',
				// Multipart form submission normalizes textarea line endings to CRLF.
				content: '수정한 점검 기록\r\n둘째 문단',
				aliases: '설비 검사, 점검 안내',
				editor: 'Operator-A',
				summary: '점검 기록 보완'
			};
			const params = { slug: '장비-점검' };
			async function seed() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = 'test-only-key';
				const [document] =
					await sql`INSERT INTO documents (slug,title,content) VALUES ('장비-점검','장비 점검','이전 기록') RETURNING *`;
				await sql`INSERT INTO revisions (document_id,content,editor_handle,summary) VALUES (${document.id},'이전 기록','Editor-01','최초 기록')`;
				await sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES ('기존-점검','기존 점검',${document.id})`;
			}
			function request(input) {
				const form = new FormData();
				for (const [key, value] of Object.entries(input)) form.set(key, value);
				return {
					params,
					request: new Request('http://localhost/edit/장비-점검?/save', {
						method: 'POST',
						body: form
					})
				};
			}
			async function save(input) {
				const current = await load({ params });
				return actions.save(
					request({ ...input, version: current.version, documentId: current.document?.id || '' })
				);
			}
			async function snapshot() {
				return {
					documents: [...(await sql`SELECT * FROM documents ORDER BY id`)],
					revisions: [...(await sql`SELECT * FROM revisions ORDER BY id`)],
					aliases: [...(await sql`SELECT * FROM redirects ORDER BY id`)]
				};
			}
			function preserveInput(result, input) {
				for (const key of Object.keys(values)) assert.equal(result.data[key], input[key]);
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
				'all exposed fields block locally while preserving exact inputs and database state',
				async (st) => {
					const calls = interceptAI(st);
					for (const [field, value] of [
						['title', ' 900101-1000000 장비 '],
						['content', '\r\npassword=NotARealSecret42!\r\n'],
						['aliases', '설비 검사, 900101-1000000'],
						['summary', '  password=NotARealSecret42! 변경 기록  ']
					]) {
						await seed();
						const before = await snapshot();
						const input = { ...values, [field]: value };
						const result = await save(input);
						assert.equal(result.status, 400);
						preserveInput(result, input);
						assert.ok(result.data.governance.fields.some((failure) => failure.field === field));
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal(calls.length, 0);
				}
			);

			await t.test(
				'invalid required fields and handles preserve raw input before any AI or database write',
				async (st) => {
					const calls = interceptAI(st);
					for (const [field, value] of [
						['title', '   '],
						['content', ' \r\n '],
						['editor', ' invalid handle ']
					]) {
						await seed();
						const before = await snapshot();
						const input = { ...values, [field]: value };
						const result = await save(input);
						assert.equal(result.status, 400);
						preserveInput(result, input);
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal(calls.length, 0);
				}
			);

			await t.test(
				'semantic rejection never saves content, aliases or a new revision',
				async (st) => {
					const calls = interceptAI(st, { passed: false, reasons: ['검토 필요'] });
					await seed();
					const before = await snapshot();
					const result = await save(values);
					assert.equal(result.status, 400);
					preserveInput(result, values);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 1);
				}
			);

			await t.test(
				'semantic outages preserve the editor input and leave persisted data unchanged',
				async (st) => {
					const calls = interceptAI(st, null, 429);
					await seed();
					const before = await snapshot();
					const result = await save(values);
					assert.equal(result.status, 503);
					preserveInput(result, values);
					assert.equal(result.data.governance.semantic.unavailable, true);
					assert.deepEqual(await snapshot(), before);
					assert.equal(calls.length, 1);
				}
			);

			await t.test(
				'passed inspection includes title, content, aliases and summary before saving',
				async (st) => {
					const calls = interceptAI(st);
					await seed();
					await assert.rejects(save(values), { status: 303 });
					assert.equal(calls.length, 1);
					for (const value of [
						values.title,
						values.content,
						values.summary,
						'설비 검사',
						'점검 안내'
					])
						assert.ok(calls[0].input.includes(value));
					const saved = await snapshot();
					assert.equal(saved.documents[0].content, values.content);
					assert.equal(saved.revisions.length, 2);
					assert.equal(saved.revisions[1].summary, values.summary);
				}
			);

			await t.test(
				'missing key is disclosed and preserves manual editing and existing history',
				async (st) => {
					const calls = interceptAI(st);
					await seed();
					state.env.OPENAI_API_KEY = '';
					const data = await load({ params });
					assert.equal(data.semanticAvailable, false);
					await assert.rejects(save(values), { status: 303 });
					const saved = await snapshot();
					assert.equal(saved.documents[0].slug, params.slug);
					assert.equal(saved.revisions[0].content, '이전 기록');
					assert.equal(saved.revisions.length, 2);
					// The submitted replacement list explicitly removed the old alias.
					assert.equal(
						saved.aliases.some((alias) => alias.alias_title === '기존 점검'),
						false
					);
					assert.deepEqual(
						saved.aliases.map((alias) => alias.alias_title),
						['설비 검사', '점검 안내']
					);
					assert.equal(calls.length, 0);
				}
			);

			await t.test(
				'database write errors keep the input without revealing internal error details',
				async (st) => {
					interceptAI(st);
					await seed();
					const before = await snapshot();
					await sql.unsafe(
						"CREATE FUNCTION fail_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-private-database-detail'; END $$"
					);
					await sql.unsafe(
						'CREATE TRIGGER fail_edit BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION fail_edit()'
					);
					try {
						const result = await save(values);
						assert.equal(result.status, 500);
						assert.doesNotMatch(result.data.message, /test-private-database-detail/);
						preserveInput(result, values);
						assert.deepEqual(await snapshot(), before);
					} finally {
						await sql.unsafe('DROP TRIGGER fail_edit ON documents');
					}
				}
			);

			await t.test(
				'database read errors are generic and retain the keyless inspection notice',
				async () => {
					state.env.OPENAI_API_KEY = '';
					await sql.unsafe('ALTER TABLE documents RENAME TO temporarily_unavailable_documents');
					try {
						const data = await load({ params });
						assert.equal(data.semanticAvailable, false);
						assert.doesNotMatch(data.databaseError, /relation|documents|SELECT/i);
						assert.match(data.databaseError, /불러오지 못했습니다/);
					} finally {
						await sql.unsafe('ALTER TABLE temporarily_unavailable_documents RENAME TO documents');
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
