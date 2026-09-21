import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { presentationFile } from './fixtures/office.js';
import { blockedTopicCases } from './fixtures/governance-topics.js';

test(
	'relaxed upload policy through parsing, real PostgreSQL and publication',
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
					name: 'isolated-relaxed-upload',
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
			const sql = state.db();
			const { POST } = await server.ssrLoadModule('/src/routes/api/wikify/+server.js');
			const { load, actions } = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			const source =
				'대외비 급여 업무 안내: 홍길동, 사번: demo42, test.user@example.invalid, 010-0000-0000';
			const filename = 'confidential-인사정보-급여.pptx';
			const generated = {
				documents: [
					{
						title: '급여 업무 안내',
						sections: [{ heading: '내부 담당자', content: source }],
						aliases: ['인사정보'],
						suggestedLinks: []
					}
				]
			};
			async function upload(text = source, name = filename) {
				const original = await presentationFile(),
					zip = await JSZip.loadAsync(await original.arrayBuffer());
				const part = 'ppt/slides/slide10.xml';
				zip.file(part, (await zip.file(part).async('string')).replace('인계 ', text + ' '));
				const body = new FormData();
				body.set('file', new File([await zip.generateAsync({ type: 'nodebuffer' })], name));
				body.set('editor', 'Editor-01');
				return POST({
					request: new Request('http://localhost/api/wikify', { method: 'POST', body })
				});
			}
			function event(fields) {
				const body = new FormData();
				for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
				return { request: new Request('http://localhost/drafts', { method: 'POST', body }) };
			}
			async function fields(id) {
				const { selected } = await load({ url: new URL('http://localhost/drafts?open=' + id) });
				return {
					id,
					version: selected.version,
					title: selected.title,
					content: selected.content,
					aliases: selected.aliases.join('\n'),
					editor: selected.editor_handle
				};
			}
			function mockAI(st, result = generated, plannedTopics = null) {
				const calls = [];
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					const request = JSON.parse(options.body);
					calls.push(request);
					const value =
						request.text?.format?.name === 'wiki_documents'
							? result.documents.length > 8
								? {
										documents: result.documents.filter((document) =>
											JSON.parse(request.input).topics.some(
												(topic) => topic.title === document.title
											)
										)
									}
								: result
							: request.text?.format?.name === 'wiki_document_topics'
								? {
										topics:
											plannedTopics ||
											result.documents.map(({ title }) => ({ title, scope: '업무 안내' }))
									}
								: { passed: true, reasons: [] };
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
			for (const withKey of [false, true])
				await t.test(
					`ordinary file uploads, updates and publishes without losing contacts (key=${withKey})`,
					async (st) => {
						await state.clearDatabase();
						state.env.OPENAI_API_KEY = withKey ? 'test-only-key' : '';
						const calls = mockAI(st);
						const response = await upload();
						assert.equal(response.status, 201);
						const result = await response.json();
						assert.equal(result.drafts[0].status, 'review');
						assert.equal(result.semanticSkipped, !withKey);
						const id = result.drafts[0].id;
						let [draft] = await sql`SELECT * FROM drafts WHERE id=${id}`;
						assert.ok(draft.content.includes(source));
						assert.equal(draft.source_name, filename);
						await assert.rejects(actions.update(event(await fields(id))), { status: 303 });
						await assert.rejects(actions.publish(event(await fields(id))), { status: 303 });
						[draft] = await sql`SELECT * FROM drafts WHERE id=${id}`;
						assert.equal(draft.status, 'published');
						assert.equal(draft.governance.passed, true);
						const [doc] = await sql`SELECT * FROM documents`;
						assert.ok(doc.content.includes(source));
						assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 1);
						assert.equal(calls.length, withKey ? 5 : 0);
						if (withKey) assert.match(calls[0].instructions, /기본 판정은 허용/);
					}
				);
			await t.test(
				'previously blocked ordinary drafts become reviewable after explicit recheck, retaining ID and source',
				async (st) => {
					await state.clearDatabase();
					state.env.OPENAI_API_KEY = '';
					const calls = mockAI(st);
					const [old] =
						await sql`INSERT INTO drafts(title,slug,content,aliases,source_name,status,governance) VALUES('대외비 급여 안내','급여-안내',${source},'["인사정보"]',${filename},'blocked','{"passed":false,"regex":{"passed":false,"reasons":["인사 또는 급여 정보"]}}') RETURNING *`;
					await assert.rejects(actions.update(event(await fields(old.id))), { status: 303 });
					const [saved] = await sql`SELECT * FROM drafts WHERE id=${old.id}`;
					assert.equal(saved.status, 'review');
					assert.equal(saved.content, old.content);
					assert.equal(saved.source_name, old.source_name);
					assert.deepEqual(saved.aliases, old.aliases);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'identity numbers and credentials still stop before AI and database writes',
				async (st) => {
					await state.clearDatabase();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const calls = mockAI(st);
					for (const [text, name] of [
						['900101-1000000', filename],
						['password=NotARealSecret42!', filename],
						[source, '900101-1000000.pptx']
					])
						assert.equal((await upload(text, name)).status, 422);
					assert.equal(calls.length, 0);
					assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 0);
				}
			);
			for (const { name, value } of blockedTopicCases)
				await t.test(
					`escaped topic ${name} preserves existing data and allows a safe retry`,
					async (st) => {
						await state.clearDatabase();
						state.env.OPENAI_API_KEY = 'test-only-key';
						const [existing] =
							await sql`INSERT INTO documents(title,slug,content) VALUES('기존 안내','existing-guide','기존 원문') RETURNING id`;
						await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${existing.id},'기존 원문','Editor-01')`;
						await sql`INSERT INTO redirects(document_id,alias_title,alias_slug) VALUES(${existing.id},'기존 별칭','existing-alias')`;
						await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${existing.id},'기존 질문','기존 토론','Editor-01')`;
						const [oldDraft] =
							await sql`INSERT INTO drafts(title,slug,content,source_name) VALUES('기존 초안','existing-draft','수정 중인 내용','existing.pptx') RETURNING *`;
						const snapshot = async () =>
							(
								await sql`SELECT jsonb_build_object(
								'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
								'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
								'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
								'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
								'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
							)[0].data;
						const before = await snapshot();
						const documents = Array.from({ length: 32 }, (_, index) => ({
							...generated.documents[0],
							title: `세부 점검 ${index + 1}`,
							aliases: []
						}));
						const topics = documents.map(({ title }) => ({ title, scope: '점검 방법' }));
						topics.at(-1).scope = value;
						const calls = mockAI(st, { documents }, topics);
						const blocked = await upload();
						assert.equal(blocked.status, 422);
						assert.equal(calls.length, 2, 'No document generation batch may receive the topic');
						assert.deepEqual(await snapshot(), before);
						const rejection = await blocked.json();
						assert.ok(!rejection.message.includes(value));
						assert.doesNotMatch(rejection.message, /NotARealSecret42|BEGIN PRIVATE KEY/);
						topics.at(-1).scope = '점검 방법';
						const retry = await upload();
						assert.equal(retry.status, 201);
						assert.equal((await retry.json()).count, 32);
						assert.equal(calls.length, 8);
						const after = await snapshot();
						assert.equal(after.drafts.length, 33);
						assert.deepEqual(
							after.drafts.filter((draft) => String(draft.id) === String(oldDraft.id)),
							before.drafts
						);
						assert.deepEqual({ ...after, drafts: before.drafts }, before);
					}
				);
			await t.test(
				'one uploaded file stores separate linked topics and publishes each without changing existing documents',
				async (st) => {
					await state.clearDatabase();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const [existing] =
						await sql`INSERT INTO documents(title,slug,content) VALUES('기존 매뉴얼','기존-매뉴얼','보존할 사용자 본문') RETURNING *`;
					const documents = [
						{
							title: '교대 인계',
							sections: [
								{
									heading: '전달',
									content: '설비 점검을 마친 뒤 운전 상태를 다음 근무자에게 전달합니다.'
								}
							],
							aliases: ['근무 인계'],
							suggestedLinks: ['설비 점검']
						},
						{
							title: '설비 점검',
							sections: [
								{
									heading: '확인',
									content: '압력계를 확인합니다. 이상이 있으면 이상 보고를 진행합니다.'
								}
							],
							aliases: [],
							suggestedLinks: ['이상 보고']
						},
						{
							title: '이상 보고',
							sections: [
								{
									heading: '보고',
									content: '당직자에게 발견한 이상을 보고하고 교대 인계에 기록합니다.'
								}
							],
							aliases: [],
							suggestedLinks: ['교대 인계']
						}
					];
					const calls = mockAI(st, { documents });
					const response = await upload(
						documents.map((doc) => doc.sections[0].content).join(' '),
						'교대-업무.pptx'
					);
					assert.equal(response.status, 201);
					const result = await response.json();
					assert.equal(result.count, 3);
					assert.equal(calls.length, 3);
					assert.deepEqual(
						result.drafts.map((draft) => draft.title),
						documents.map((doc) => doc.title)
					);
					assert.ok(
						result.drafts.every((draft) => draft.status === 'review' && draft.linkCount === 1)
					);
					const drafts = await sql`SELECT * FROM drafts ORDER BY id`;
					assert.ok(drafts.every((draft) => draft.source_name === '교대-업무.pptx'));
					assert.equal(new Set(drafts.map((draft) => draft.slug)).size, 3);
					assert.match(drafts[0].content, /\[\[설비 점검\]\]/);
					const first = await fields(drafts[0].id);
					await assert.rejects(
						actions.update(
							event({ ...first, content: first.content + '\n\n검토자가 추가한 인계 설명.' })
						),
						{ status: 303 }
					);
					assert.deepEqual(
						[...(await sql`SELECT * FROM drafts WHERE id<>${drafts[0].id} ORDER BY id`)],
						drafts.slice(1)
					);
					for (const draft of drafts) {
						await assert.rejects(actions.publish(event(await fields(draft.id))), { status: 303 });
					}
					assert.equal(
						(await sql`SELECT count(*)::int n FROM drafts WHERE status='published'`)[0].n,
						3
					);
					assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 3);
					assert.equal((await sql`SELECT count(*)::int n FROM documents`)[0].n, 4);
					assert.deepEqual(
						(await sql`SELECT * FROM documents WHERE id=${existing.id}`)[0],
						existing
					);
					assert.match(
						(await sql`SELECT content FROM documents WHERE title='교대 인계'`)[0].content,
						/검토자가 추가한 인계 설명/
					);
					assert.equal((await sql`SELECT alias_title FROM redirects`)[0].alias_title, '근무 인계');
				}
			);
			await t.test(
				'32 fine drafts commit together, preserve existing data and roll back a late INSERT failure',
				async (st) => {
					await state.clearDatabase();
					state.env.OPENAI_API_KEY = 'test-only-key';
					const [existing] =
						await sql`INSERT INTO drafts(title,slug,content,source_name) VALUES('기존 초안','기존-초안','사용자 원문 유지','기존자료.pdf') RETURNING *`;
					const documents = Array.from({ length: 32 }, (_, i) => ({
						title: `세부 장비 ${i + 1} 점검`,
						sections: [
							{
								heading: '기준',
								content: `교육 기준 ${i + 1} mm. 확인 후 세부 장비 ${((i + 8) % 32) + 1} 점검을 진행합니다.`
							}
						],
						aliases: [`점검 항목 ${i + 1}`],
						suggestedLinks: [`세부 장비 ${((i + 8) % 32) + 1} 점검`]
					}));
					const calls = mockAI(st, { documents });
					const text = documents
						.map((document) => document.title + ' ' + document.sections[0].content)
						.join(' ');
					await sql`CREATE FUNCTION fine_upload_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='세부 장비 29 점검' THEN RAISE EXCEPTION 'synthetic-late-insert'; END IF; RETURN NEW; END $$`;
					await sql`CREATE TRIGGER fine_upload_fail BEFORE INSERT ON drafts FOR EACH ROW EXECUTE FUNCTION fine_upload_fail()`;
					try {
						assert.equal((await upload(text, '세부-점검.pptx')).status, 500);
						assert.deepEqual([...(await sql`SELECT * FROM drafts`)], [existing]);
					} finally {
						await sql`DROP TRIGGER fine_upload_fail ON drafts`;
						await sql`DROP FUNCTION fine_upload_fail()`;
					}
					const response = await upload(text, '세부-점검.pptx');
					assert.equal(response.status, 201);
					assert.equal((await response.json()).count, 32);
					const drafts = await sql`SELECT * FROM drafts WHERE id<>${existing.id} ORDER BY id`;
					assert.equal(drafts.length, 32);
					assert.deepEqual(
						drafts.map((draft) => draft.title),
						documents.map((document) => document.title)
					);
					assert.ok(
						drafts.every(
							(draft) => draft.status === 'review' && draft.source_name === '세부-점검.pptx'
						)
					);
					assert.deepEqual(
						drafts.map((draft) => draft.aliases),
						documents.map((document) => document.aliases)
					);
					assert.match(drafts[0].content, /\[\[세부 장비 9 점검\]\]/);
					assert.deepEqual((await sql`SELECT * FROM drafts WHERE id=${existing.id}`)[0], existing);
					assert.equal((await sql`SELECT count(*)::int n FROM documents`)[0].n, 0);
					assert.equal(calls.length, 12);
				}
			);
			await t.test(
				'partial upload insertion is rolled back and retry stores the full batch once',
				async (st) => {
					await state.clearDatabase();
					state.env.OPENAI_API_KEY = 'test-only-key';
					mockAI(st, {
						documents: [
							...generated.documents,
							{ ...generated.documents[0], title: '급여 담당자 안내' }
						]
					});
					await sql`CREATE FUNCTION relaxed_upload_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='급여 담당자 안내' THEN RAISE EXCEPTION 'synthetic-upload-failure'; END IF; RETURN NEW; END $$`;
					await sql`CREATE TRIGGER relaxed_upload_fail BEFORE INSERT ON drafts FOR EACH ROW EXECUTE FUNCTION relaxed_upload_fail()`;
					try {
						assert.equal((await upload()).status, 500);
						assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 0);
					} finally {
						await sql`DROP TRIGGER relaxed_upload_fail ON drafts`;
						await sql`DROP FUNCTION relaxed_upload_fail()`;
					}
					const response = await upload();
					assert.equal(response.status, 201);
					assert.equal((await response.json()).count, 2);
					assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 2);
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
