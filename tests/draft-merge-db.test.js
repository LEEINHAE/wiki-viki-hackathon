import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';

test(
	'AI merge proposals preserve drafts and published documents with PostgreSQL',
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
					name: 'isolated-merge',
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
			const { generateMerge } = await server.ssrLoadModule('/src/lib/server/merge-ai.js');
			const { draftFingerprint } = await server.ssrLoadModule('/src/lib/server/draft-merge.js');
			const output = {
				content: '3일마다 점검.\n\n별도 보관 정보. 출처: 운영 안내. [[안전]] 주의.',
				summary: '주기를 7일에서 3일로 변경하고 보관 정보를 유지.',
				conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }]
			};
			async function seed() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
				const [doc] =
					await sql`INSERT INTO documents(title,slug,content,updated_at) VALUES('장비 점검','장비-점검','7일마다 점검.\n\n별도 보관 정보. 출처: 운영 안내. [[안전]] 주의.','2026-09-20 01:02:03.123456+00') RETURNING *`;
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('확인-절차','확인 절차',${doc.id})`;
				await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${doc.id},${doc.content},'Editor-01','기존 이력')`;
				const [draft] =
					await sql`INSERT INTO drafts(title,slug,content,aliases,source_name,governance) VALUES('새 점검','새-점검','3일마다 점검.','["확인 절차"]','공개 예제.docx','{"custom":{"kept":true}}') RETURNING *`;
				return { doc, draft };
			}
			async function page(id) {
				return load({ url: new URL('http://localhost/drafts?open=' + id) });
			}
			async function fields(id) {
				const data = await page(id),
					d = data.selected,
					target = data.targets[0];
				return {
					id: String(id),
					version: d.version,
					title: d.title,
					content: d.content,
					aliases: d.aliases.join('\n'),
					editor: d.editor_handle,
					target: target ? `${target.id}:${target.version}` : ''
				};
			}
			async function post(input, action = 'generateMerge') {
				const body = new FormData();
				for (const [k, v] of Object.entries(input)) body.set(k, String(v));
				try {
					return await actions[action]({
						request: new Request('http://localhost/drafts', { method: 'POST', body })
					});
				} catch (error) {
					if (error.status === 303) return error;
					throw error;
				}
			}
			async function published() {
				return (
					await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r)) AS data`
				)[0].data;
			}
			async function drafts() {
				return (await sql`SELECT jsonb_agg(to_jsonb(d) ORDER BY id) AS data FROM drafts d`)[0].data;
			}
			function ai(
				st,
				{
					result = output,
					before = async () => {},
					semantic = { passed: true, reasons: [] },
					status = 'completed',
					refusal = false,
					http = 200
				} = {}
			) {
				const calls = [];
				state.env.OPENAI_API_KEY = 'test-only-key';
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					const input = JSON.parse(options.body);
					calls.push(input);
					await before(input);
					const merging = input.text?.format?.name === 'wiki_merge';
					if (merging && http !== 200)
						return Response.json(
							{ error: { message: 'private-failure-detail' } },
							{ status: http }
						);
					return Response.json({
						object: 'response',
						status: merging ? status : 'completed',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content:
									merging && refusal
										? [{ type: 'refusal', refusal: 'refused' }]
										: [
												{
													type: 'output_text',
													text: merging
														? typeof result === 'string'
															? result
															: JSON.stringify(result)
														: JSON.stringify(semantic)
												}
											]
							}
						]
					});
				});
				return calls;
			}
			const kept = (result, input) => {
				for (const key of ['id', 'version', 'title', 'content', 'aliases', 'editor', 'target'])
					assert.equal(
						result.data[key].replace(/\r\n/g, '\n'),
						input[key].replace(/\r\n/g, '\n'),
						key
					);
			};

			await t.test(
				'active alias matches, manual targets and trash exclusion use exact string IDs',
				async () => {
					const { draft, doc } = await seed();
					await sql`INSERT INTO documents(id,title,slug,content) VALUES(9007199254740993,'직접 선택','manual','수동 대상'),(9007199254740992,'보관됨','archived','보관 자료')`;
					await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-01' WHERE slug='archived'`;
					const data = await page(draft.id);
					assert.equal(data.targets.length, 2);
					assert.equal(data.targets.filter((d) => d.matched).length, 1);
					assert.equal(data.targets.find((d) => d.matched).id, String(doc.id));
					assert.equal(data.targets.find((d) => d.slug === 'manual').id, '9007199254740993');
					assert.equal(
						data.targets.some((d) => d.content || d.snapshot),
						false
					);
				}
			);
			await t.test(
				'generation only saves a bounded proposal with provenance and precise target version',
				async (st) => {
					const { draft } = await seed(),
						before = await published(),
						old = (await drafts())[0];
					const calls = ai(st),
						result = await post(await fields(draft.id));
					assert.equal(result.status, 303);
					assert.equal(calls.length, 2);
					assert.equal(calls[1].store, false);
					assert.equal(calls[1].text.format.strict, true);
					assert.deepEqual(Object.keys(JSON.parse(calls[1].input)), ['existing', 'incoming']);
					assert.doesNotMatch(calls[1].input, /공개 예제|확인 절차|editor_handle/);
					assert.match(calls[1].instructions, /새 초안을 우선/);
					assert.match(calls[1].instructions, /기존 문서의 제목·주소는 유지/);
					assert.match(calls[1].instructions, /출처, 주의 사항/);
					const data = await page(draft.id),
						saved = (await drafts())[0];
					assert.equal(data.proposal.stale, false);
					assert.equal(data.proposal.content, output.content);
					assert.deepEqual(data.proposal.conflicts, output.conflicts);
					assert.match(data.proposal.targetVersion, /123456/);
					assert.equal(data.proposal.draftFingerprint, draftFingerprint(old));
					assert.equal(
						data.proposal.diff.some((part) => part.removed && part.value.includes('7일')),
						true
					);
					assert.equal(
						data.proposal.diff.some((part) => part.added && part.value.includes('3일')),
						true
					);
					for (const key of [
						'id',
						'title',
						'slug',
						'content',
						'aliases',
						'source_name',
						'status',
						'editor_handle',
						'created_at'
					])
						assert.deepEqual(saved[key], old[key]);
					assert.deepEqual(saved.governance.custom, old.governance.custom);
					assert.deepEqual(await published(), before);
				}
			);
			await t.test(
				'manual selection of an unrelated title targets that exact active document',
				async (st) => {
					const { draft } = await seed();
					await sql`INSERT INTO documents(title,slug,content) VALUES('직접 선택','manual','다른 원문')`;
					const target = (await page(draft.id)).targets.find((d) => d.slug === 'manual');
					ai(st);
					assert.equal(
						(await post({ ...(await fields(draft.id)), target: `${target.id}:${target.version}` }))
							.status,
						303
					);
					assert.equal((await page(draft.id)).proposal.targetId, target.id);
				}
			);
			for (const [label, patch] of [
				['ID', { id: '90071992547409930x' }],
				['version', { version: '' }],
				['target', { target: '' }],
				['target version', { target: '1:bad' }],
				['unsaved body', { content: '작성 중 입력' }],
				['unsaved alias', { aliases: '저장 전 별칭' }]
			])
				await t.test(`invalid ${label} is rejected before any external request`, async (st) => {
					const { draft } = await seed(),
						before = await drafts(),
						input = { ...(await fields(draft.id)), ...patch },
						calls = ai(st);
					const result = await post(input);
					assert.equal(result.status, 400);
					kept(result, input);
					assert.equal(calls.length, 0);
					assert.deepEqual(await drafts(), before);
				});
			await t.test('missing key never fabricates a merge or changes records', async (st) => {
				const { draft } = await seed(),
					before = await drafts(),
					calls = ai(st);
				state.env.OPENAI_API_KEY = '';
				assert.equal((await page(draft.id)).mergeAvailable, false);
				assert.equal((await post(await fields(draft.id))).status, 503);
				assert.equal(calls.length, 0);
				assert.deepEqual(await drafts(), before);
			});
			for (const field of ['existing title', 'existing body', 'incoming title', 'incoming body'])
				await t.test(`${field} local sensitive content blocks all AI calls`, async (st) => {
					const { draft } = await seed();
					if (field === 'existing title')
						await sql`UPDATE documents SET title='900101-1000000 장비'`;
					if (field === 'existing body')
						await sql`UPDATE documents SET content='900101-1000000 본문'`;
					if (field === 'incoming title') await sql`UPDATE drafts SET title='900101-1000000 초안'`;
					if (field === 'incoming body') await sql`UPDATE drafts SET content='900101-1000000 입력'`;
					const calls = ai(st),
						before = await drafts();
					const result = await post(await fields(draft.id));
					assert.equal(result.status, 400);
					assert.equal(result.data.recoveryBlocked, true);
					assert.equal(calls.length, 0);
					assert.deepEqual(await drafts(), before);
				});
			for (const [label, options, expected, count] of [
				['semantic blocked', { semantic: { passed: false, reasons: ['확인 필요'] } }, 400, 1],
				['semantic malformed', { semantic: { passed: 'true', reasons: [] } }, 503, 1],
				['invalid JSON', { result: 'not JSON' }, 502, 2],
				[
					'wrong schema',
					{
						result: { ...output, conflicts: [{ topic: '주기', existing: '7일', incoming: '3일' }] }
					},
					502,
					2
				],
				['oversized output', { result: { ...output, content: 'x'.repeat(200001) } }, 502, 2],
				['refusal', { refusal: true }, 502, 2],
				['incomplete', { status: 'incomplete' }, 502, 2],
				['external failure', { http: 500 }, 503, 2],
				[
					'sensitive output',
					{ result: { ...output, content: '900101-1000000 생성 결과' } },
					400,
					2
				],
				[
					'sensitive conflict',
					{
						result: {
							...output,
							conflicts: [{ topic: '연락처', previous: '공개 정보', incoming: '900101-1000000' }]
						}
					},
					400,
					2
				]
			])
				await t.test(`${label} preserves a previous proposal without fallback`, async (st) => {
					const { draft } = await seed();
					await sql`UPDATE drafts SET governance=governance || '{"merge":{"id":"previous"}}'::jsonb`;
					const before = await drafts(),
						docs = await published(),
						calls = ai(st, options),
						input = await fields(draft.id),
						result = await post(input);
					assert.equal(result.status, expected);
					assert.equal(result.data.recoveryBlocked, expected === 400 ? true : undefined);
					kept(result, input);
					assert.equal(calls.length, count);
					assert.deepEqual(await drafts(), before);
					assert.deepEqual(await published(), docs);
					assert.doesNotMatch(result.data.message, /private-failure/);
				});
			await t.test(
				'input size boundary is exact and generator independently guards direct calls',
				async (st) => {
					const calls = ai(st);
					const existing = { title: 'A', content: 'x'.repeat(199997) },
						incoming = { title: 'B', content: 'y' };
					await generateMerge(existing, incoming);
					assert.equal(calls.length, 2);
					await assert.rejects(
						generateMerge(existing, { ...incoming, content: 'yy' }),
						(e) => e.status === 400
					);
					assert.equal(calls.length, 2);
					await assert.rejects(
						generateMerge(
							{ title: 'A', content: '공개 본문' },
							{ ...incoming, content: '900101-1000000' }
						),
						{ name: 'ContentBlockedError' }
					);
					assert.equal(calls.length, 2);
				}
			);
			for (const change of [
				'draft',
				'target',
				'aliases',
				'trash',
				'trash restore',
				'published',
				'deleted'
			])
				await t.test(`during AI ${change} change refuses stale storage`, async (st) => {
					const { draft, doc } = await seed(),
						input = await fields(draft.id);
					ai(st, {
						before: async (call) => {
							if (call.text?.format?.name !== 'wiki_merge') return;
							if (change === 'draft') await sql`UPDATE drafts SET content='동시 수정'`;
							if (change === 'target') await sql`UPDATE documents SET content='동시 수정'`;
							if (change === 'aliases') await sql`UPDATE redirects SET alias_title='변경된 별칭'`;
							if (change.startsWith('trash'))
								await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-01',lifecycle_version=lifecycle_version+1 WHERE id=${doc.id}`;
							if (change === 'trash restore')
								await sql`UPDATE documents SET deleted_at=NULL,deleted_by=NULL,lifecycle_version=lifecycle_version+1 WHERE id=${doc.id}`;
							if (change === 'published') await sql`UPDATE drafts SET status='published'`;
							if (change === 'deleted') await sql`DELETE FROM drafts`;
						}
					});
					const result = await post(input);
					assert.equal(result.status, 409);
					kept(result, input);
					assert.equal(
						((await drafts()) || []).some((d) => d.governance.merge),
						false
					);
				});
			await t.test('stale versions and archived targets are rejected before AI', async (st) => {
				const { draft } = await seed(),
					input = await fields(draft.id),
					calls = ai(st);
				await sql`UPDATE redirects SET alias_title='새 별칭'`;
				assert.equal((await post(input)).status, 409);
				assert.equal(calls.length, 0);
				const fresh = await fields(draft.id);
				await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-01'`;
				assert.equal((await post(fresh)).status, 409);
				assert.equal(calls.length, 0);
			});
			await t.test(
				'regenerate, stale display and versioned discard preserve all other data',
				async (st) => {
					const { draft } = await seed(),
						before = await published();
					ai(st);
					assert.equal((await post(await fields(draft.id))).status, 303);
					const first = (await page(draft.id)).proposal,
						old = await fields(draft.id);
					assert.equal((await post(old)).status, 303);
					const second = (await page(draft.id)).proposal;
					assert.notEqual(first.id, second.id);
					assert.equal((await post({ ...old, proposalId: first.id }, 'discardMerge')).status, 409);
					await sql`UPDATE documents SET content='다른 문서 수정'`;
					assert.equal((await page(draft.id)).proposal.stale, true);
					const discard = { ...(await fields(draft.id)), proposalId: second.id };
					assert.equal((await post(discard, 'discardMerge')).status, 303);
					assert.equal((await post(discard, 'discardMerge')).status, 409);
					assert.equal((await page(draft.id)).proposal, null);
					assert.equal((await drafts())[0].governance.custom.kept, true);
					assert.equal((await published()).revisions.length, before.revisions.length);
				}
			);
			for (const behavior of ['exception', 'skip'])
				await t.test(
					`proposal UPDATE trigger ${behavior} rolls back and retry succeeds`,
					async (st) => {
						const { draft } = await seed();
						ai(st);
						const before = await drafts(),
							docs = await published(),
							input = await fields(draft.id);
						await sql.unsafe(
							`CREATE FUNCTION fail_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${behavior === 'exception' ? "RAISE EXCEPTION 'private-db-error';" : 'RETURN NULL;'} END $$`
						);
						await sql`CREATE TRIGGER fail_merge BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION fail_merge()`;
						try {
							assert.equal((await post(input)).status, 503);
							assert.deepEqual(await drafts(), before);
							assert.deepEqual(await published(), docs);
						} finally {
							await sql`DROP TRIGGER fail_merge ON drafts`;
							await sql`DROP FUNCTION fail_merge()`;
						}
						assert.equal((await post(input)).status, 303);
					}
				);
			await t.test(
				'two independent concurrent generators save once and retain the winning proposal',
				async (st) => {
					const { draft } = await seed(),
						input = await fields(draft.id),
						before = await published();
					let arrived = 0,
						release;
					const gate = new Promise((r) => (release = r));
					ai(st, {
						before: async (call) => {
							if (call.text?.format?.name === 'wiki_merge') {
								arrived++;
								if (arrived === 2) release();
								await gate;
							}
						}
					});
					const results = await Promise.all([post(input), post(input)]);
					assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
					assert.equal((await page(draft.id)).proposal.stale, false);
					assert.deepEqual(await published(), before);
				}
			);
			await t.test(
				'document lock waits for a concurrent committed edit then refuses the old proposal',
				async (st) => {
					const { draft } = await seed(),
						input = await fields(draft.id);
					let acquired, release;
					const locked = new Promise((r) => (acquired = r)),
						gate = new Promise((r) => (release = r));
					const editing = sql.begin(async (tx) => {
						await tx`LOCK TABLE documents IN ROW EXCLUSIVE MODE`;
						await tx`UPDATE documents SET content='독립 연결 편집'`;
						acquired();
						await gate;
					});
					await locked;
					ai(st);
					const pending = post(input);
					await delay(100);
					const [{ count }] =
						await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE documents, redirects%'`;
					release();
					await editing;
					assert.equal((await pending).status, 409);
					assert.ok(count >= 1);
					assert.equal((await page(draft.id)).proposal, null);
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
