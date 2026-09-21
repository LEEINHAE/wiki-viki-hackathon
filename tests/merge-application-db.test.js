import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';

test(
	'reviewed AI merge application and history are atomic with PostgreSQL',
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
					name: 'isolated-merge-apply',
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
			const history = await server.ssrLoadModule('/src/routes/history/[slug]/+page.server.js');
			const { getEditableDocument } = await server.ssrLoadModule(
				'/src/lib/server/document-write.js'
			);
			const { getDraft } = await server.ssrLoadModule('/src/lib/server/draft-write.js');
			const { createProposal, saveProposal } = await server.ssrLoadModule(
				'/src/lib/server/draft-merge.js'
			);
			const output = {
				content: '3일마다 점검.\n\n건조한 보관함. 전원 분리 주의. 출처: 가상 안내. [[보관]]',
				summary: '점검 주기를 3일로 변경하고 보관 정보 유지.',
				conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }]
			};
			async function seed({
				patchDraft = {},
				patchProposal = {},
				patchTarget = {},
				proposal = true
			} = {}) {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
				const [doc] =
					await sql`INSERT INTO documents(title,slug,content,updated_at) VALUES('장비 점검','장비-점검','7일마다 점검.\n\n건조한 보관함. 전원 분리 주의. 출처: 가상 안내. [[보관]]','2026-09-20 01:02:03.123456+00') RETURNING *`;
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('legacy-url','기존 별칭',${doc.id})`;
				await sql`INSERT INTO revisions(document_id,content,editor_handle,summary,created_at) VALUES(${doc.id},${doc.content},'Editor-01','기존 이력','2026-09-20 01:02:03.123456+00')`;
				await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${doc.id},'기존 토론','유지할 의견','Editor-02')`;
				const [d] =
					await sql`INSERT INTO drafts(title,slug,content,aliases,source_name,governance) VALUES('장비 점검 개정','장비-점검-개정','3일마다 점검.','["통합 별칭"]','공개 예제.docx','{"custom":{"kept":true}}') RETURNING *`;
				for (const [key, value] of Object.entries(patchDraft))
					await sql.unsafe(`UPDATE drafts SET ${key}=$1 WHERE id=$2`, [value, d.id]);
				for (const [key, value] of Object.entries(patchTarget))
					await sql.unsafe(`UPDATE documents SET ${key}=$1 WHERE id=$2`, [value, doc.id]);
				const draft = await getDraft(sql, d.id),
					target = await getEditableDocument('', String(doc.id));
				if (proposal)
					await saveProposal(sql, draft, target, {
						...createProposal(draft, target, { result: output, model: 'test-model' }),
						...patchProposal
					});
				return { doc: target.document, draft: await getDraft(sql, d.id) };
			}
			const page = (id) => load({ url: new URL('http://localhost/drafts?open=' + id) });
			async function fields(id) {
				const d = await getDraft(sql, id),
					p = d.governance.merge;
				return {
					id: String(id),
					version: d.version,
					title: d.title,
					content: d.content,
					aliases: Array.isArray(d.aliases) ? d.aliases.join('\n') : '',
					editor: d.editor_handle,
					target: p ? `${p.targetId}:${p.targetFingerprint}` : '',
					proposalId: p?.id || '',
					finalContent: p?.content || '',
					mergeEditor: 'Editor-42',
					confirmMerge: 'yes'
				};
			}
			async function post(input, action = 'applyMerge') {
				const body = new FormData();
				for (const [k, v] of Object.entries(input)) if (v !== undefined) body.set(k, String(v));
				try {
					return await actions[action]({
						request: new Request('http://localhost/drafts', { method: 'POST', body })
					});
				} catch (error) {
					if (error.status === 303) return error;
					throw error;
				}
			}
			async function snapshot() {
				return (
					await sql`SELECT jsonb_build_object('drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) AS data`
				)[0].data;
			}
			function kept(result, input) {
				for (const key of [
					'id',
					'version',
					'title',
					'content',
					'aliases',
					'editor',
					'proposalId',
					'finalContent',
					'mergeEditor'
				])
					if (input[key] !== undefined)
						assert.equal(
							result.data[key].replace(/\r\n/g, '\n'),
							input[key].replace(/\r\n/g, '\n'),
							key
						);
			}
			function ai(
				st,
				{
					before = async () => {},
					semantic = { passed: true, reasons: [] },
					throwError = false
				} = {}
			) {
				const calls = [];
				state.env.OPENAI_API_KEY = 'test-only-key';
				st.mock.method(globalThis, 'fetch', async (_url, options) => {
					const input = JSON.parse(options.body);
					calls.push(input);
					await before(input);
					if (throwError) throw new Error('private-external-detail');
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
										text: JSON.stringify(
											input.text?.format?.name === 'wiki_merge' ? output : semantic
										)
									}
								]
							}
						]
					});
				});
				return calls;
			}
			const historyData = (slug) =>
				history.load({
					params: { slug },
					url: new URL('http://localhost/history/' + encodeURIComponent(slug))
				});

			await t.test(
				'generated proposal -> manual final edit -> exact target, aliases and detailed history -> rollback',
				async (st) => {
					const { doc, draft } = await seed({ proposal: false }),
						calls = ai(st),
						candidate = (await page(draft.id)).targets[0];
					assert.equal(
						(
							await post(
								{
									...(await fields(draft.id)),
									target: `${candidate.id}:${candidate.version}`,
									finalContent: undefined,
									mergeEditor: undefined
								},
								'generateMerge'
							)
						).status,
						303
					);
					const before = await snapshot(),
						input = {
							...(await fields(draft.id)),
							finalContent: output.content + '\n\n검토자가 추가한 안내.'
						};
					assert.equal((await post(input)).status, 303);
					assert.equal(calls.length, 3);
					assert.equal(calls[2].store, false);
					const after = await snapshot();
					assert.equal(after.documents.length, 1);
					const saved = after.documents[0];
					for (const key of [
						'id',
						'title',
						'slug',
						'created_at',
						'deleted_at',
						'deleted_by',
						'lifecycle_version'
					])
						assert.deepEqual(saved[key], before.documents[0][key]);
					assert.equal(saved.content, input.finalContent);
					assert.equal(saved.editor_handle, 'Editor-42');
					assert.notEqual(saved.updated_at, before.documents[0].updated_at);
					assert.deepEqual(after.revisions[0], before.revisions[0]);
					assert.equal(after.revisions.length, 2);
					assert.equal(after.revisions[1].content, input.finalContent);
					assert.deepEqual(after.aliases[0], before.aliases[0]);
					assert.deepEqual(
						after.aliases.map((a) => a.alias_slug).sort(),
						['legacy-url', '장비-점검-개정', '통합-별칭'].sort()
					);
					assert.deepEqual(after.discussions, before.discussions);
					assert.equal(after.drafts[0].status, 'published');
					assert.equal(after.drafts[0].governance.custom.kept, true);
					assert.equal(after.drafts[0].governance.mergedInto.id, String(doc.id));
					for (const key of [
						'title',
						'slug',
						'content',
						'aliases',
						'source_name',
						'created_at',
						'editor_handle'
					])
						assert.deepEqual(after.drafts[0][key], before.drafts[0][key]);
					assert.equal((await page(draft.id)).selected, null);
					assert.equal((await post(input)).status, 409);
					assert.equal(calls.length, 3);
					const h = await historyData(doc.slug),
						record = h.revisions[0].merge;
					assert.equal(record.draftId, String(draft.id));
					assert.equal(record.draftTitle, draft.title);
					assert.equal(record.sourceName, draft.source_name);
					assert.equal(record.manuallyEdited, true);
					assert.deepEqual(record.conflicts, output.conflicts);
					const old = h.revisions[1],
						body = new FormData();
					for (const [k, v] of Object.entries({
						revision: String(old.id),
						documentId: String(doc.id),
						version: h.version,
						revisionVersion: old.version
					}))
						body.set(k, v);
					await assert.rejects(
						history.actions.rollback({
							params: { slug: doc.slug },
							request: new Request('http://localhost/history', { method: 'POST', body })
						}),
						{ status: 303 }
					);
					assert.equal((await sql`SELECT content FROM documents`)[0].content, doc.content);
					assert.equal((await historyData(doc.slug)).revisions[1].merge.manuallyEdited, true);
					assert.equal((await sql`SELECT status FROM drafts`)[0].status, 'published');
				}
			);
			await t.test(
				'keyless application uses stored AI proposal and records skipped semantics without fabricating AI',
				async (st) => {
					const { draft, doc } = await seed(),
						calls = ai(st);
					state.env.OPENAI_API_KEY = '';
					const input = await fields(draft.id);
					input.mergeEditor = draft.editor_handle;
					assert.equal((await post(input)).status, 303);
					assert.equal(calls.length, 0);
					const d = await getDraft(sql, draft.id);
					assert.equal(d.governance.semantic.skipped, true);
					assert.equal((await historyData(doc.slug)).revisions[0].merge.manuallyEdited, false);
				}
			);
			for (const withKey of [false, true])
				await t.test(
					`internal identifier digits never block safe merging (key=${withKey})`,
					async (st) => {
						const { doc } = await seed({ proposal: false });
						const numericId = '1012345678',
							proposalId = 'a0101234-5678-4abc-8abc-abcdefabcdef';
						await sql`UPDATE drafts SET id=${numericId}`;
						const originalDraft = await getDraft(sql, numericId),
							target = await getEditableDocument('', String(doc.id));
						await saveProposal(sql, originalDraft, target, {
							...createProposal(originalDraft, target, { result: output, model: 'test-model' }),
							id: proposalId
						});
						const calls = ai(st);
						if (!withKey) state.env.OPENAI_API_KEY = '';
						const result = await post(await fields(numericId));
						assert.equal(result.status, 303);
						assert.equal(calls.length, withKey ? 1 : 0);
						if (withKey) {
							assert.ok(!calls[0].input.includes(proposalId));
							assert.ok(!calls[0].input.includes(numericId));
							for (const text of [
								doc.title,
								output.content,
								originalDraft.title,
								originalDraft.source_name,
								output.summary,
								...output.conflicts.flatMap((c) => [c.topic, c.previous, c.incoming])
							])
								assert.ok(calls[0].input.includes(text), text);
						}
						const h = await historyData(doc.slug);
						assert.equal(h.revisions[0].merge.proposalId, proposalId);
						assert.equal(h.revisions[0].merge.draftId, numericId);
						assert.deepEqual(h.revisions[0].merge.conflicts, output.conflicts);
						assert.equal(h.revisions.length, 2);
						assert.equal((await getDraft(sql, numericId)).governance.merge.id, proposalId);
					}
				);
			for (const [label, patch] of [
				['confirmation', { confirmMerge: '' }],
				['ID', { id: '9223372036854775808' }],
				['version', { version: '' }],
				['empty content', { finalContent: ' ' }],
				['long content', { finalContent: 'x'.repeat(200001) }],
				['editor', { mergeEditor: '실제 이름' }],
				['unsaved draft', { content: '미저장 입력' }],
				['unsaved aliases', { aliases: '저장 전 별칭' }],
				['changed target', { target: 'another-target' }]
			])
				await t.test(`invalid ${label} preserves inputs and makes no external call`, async (st) => {
					const { draft } = await seed(),
						before = await snapshot(),
						input = { ...(await fields(draft.id)), ...patch },
						calls = ai(st),
						result = await post(input);
					assert.equal(result.status, 400);
					kept(result, input);
					assert.equal(calls.length, 0);
					assert.deepEqual(await snapshot(), before);
				});
			await t.test('200000-character final body is accepted without truncation', async () => {
				const { draft } = await seed();
				const content = 'x'.repeat(200000);
				assert.equal(
					(await post({ ...(await fields(draft.id)), finalContent: content })).status,
					303
				);
				assert.equal((await sql`SELECT content FROM documents`)[0].content, content);
			});
			for (const [label, options, inputPatch] of [
				['final body', {}, { finalContent: '900101-1000000 자료' }],
				['target title', { patchTarget: { title: '900101-1000000 장비' } }, {}],
				['draft title', { patchDraft: { title: '900101-1000000 제목' } }, {}],
				['draft alias', { patchDraft: { aliases: '["900101-1000000"]' } }, {}],
				['source filename', { patchDraft: { source_name: '900101-1000000.docx' } }, {}],
				['summary', { patchProposal: { summary: '900101-1000000 요약' } }, {}],
				[
					'conflict',
					{
						patchProposal: {
							conflicts: [{ topic: '내용', previous: '공개', incoming: '900101-1000000 자료' }]
						}
					},
					{}
				]
			])
				await t.test(`sensitive ${label} blocks before any external transmission`, async (st) => {
					const { draft } = await seed(options),
						before = await snapshot(),
						input = { ...(await fields(draft.id)), ...inputPatch },
						calls = ai(st),
						result = await post(input);
					assert.equal(result.status, 400);
					kept(result, input);
					assert.equal(calls.length, 0);
					assert.deepEqual(await snapshot(), before);
					assert.equal(result.data.mergeGovernance.regex.passed, false);
				});
			for (const [label, options, status] of [
				['semantic refusal', { semantic: { passed: false, reasons: ['확인 필요'] } }, 400],
				['malformed inspection', { semantic: { passed: 'true', reasons: [] } }, 503],
				['network failure', { throwError: true }, 503]
			])
				await t.test(`${label} preserves all records and final edits`, async (st) => {
					const { draft } = await seed(),
						before = await snapshot(),
						calls = ai(st, options),
						input = { ...(await fields(draft.id)), finalContent: output.content + '\n추가 편집' },
						result = await post(input);
					assert.equal(result.status, status);
					kept(result, input);
					assert.equal(calls.length, 1);
					assert.deepEqual(await snapshot(), before);
					assert.doesNotMatch(result.data.message, /private-external/);
				});
			for (const patch of [
				{ id: 'different' },
				{ draftFingerprint: '0'.repeat(64) },
				{ targetFingerprint: '0'.repeat(64) },
				{ targetVersion: '2026-09-20 01:02:03.123457+09' },
				{ originalContent: '다른 원문' },
				{ targetTitle: '다른 제목' },
				{ targetSlug: 'different' },
				{ schemaVersion: 2 }
			])
				await t.test(
					`invalid stored proposal ${Object.keys(patch)[0]} is rejected before AI`,
					async (st) => {
						const { draft } = await seed({ patchProposal: patch }),
							input = await fields(draft.id),
							calls = ai(st),
							before = await snapshot();
						if (patch.id) input.proposalId = 'reviewed-old-id';
						assert.equal((await post(input)).status, 409);
						assert.equal(calls.length, 0);
						assert.deepEqual(await snapshot(), before);
					}
				);
			await t.test(
				'another proposal ID and adjacent BIGINT draft ID never apply the wrong proposal',
				async (st) => {
					const { draft } = await seed(),
						input = await fields(draft.id),
						calls = ai(st);
					assert.equal((await post({ ...input, proposalId: 'another-id' })).status, 409);
					await sql`UPDATE drafts SET id=9007199254740993 WHERE id=${draft.id}`;
					await sql`INSERT INTO drafts(id,title,slug,content) VALUES(9007199254740992,'인접 초안','adjacent','다른 본문')`;
					assert.equal(
						(await post({ ...(await fields('9007199254740993')), id: '9007199254740992' })).status,
						409
					);
					assert.equal(calls.length, 0);
				}
			);
			for (const change of [
				'draft body',
				'draft aliases',
				'source',
				'proposal',
				'target body',
				'target alias',
				'target microsecond',
				'trash restore',
				'published',
				'deleted'
			])
				await t.test(`during inspection ${change} rejects obsolete application`, async (st) => {
					const { draft, doc } = await seed(),
						input = await fields(draft.id);
					let afterChange;
					ai(st, {
						before: async () => {
							if (change === 'draft body') await sql`UPDATE drafts SET content='다른 편집'`;
							if (change === 'draft aliases')
								await sql`UPDATE drafts SET aliases='["다른 별칭"]'::jsonb`;
							if (change === 'source') await sql`UPDATE drafts SET source_name='다른 자료.docx'`;
							if (change === 'proposal') await sql`UPDATE drafts SET governance=governance-'merge'`;
							if (change === 'target body') await sql`UPDATE documents SET content='다른 편집'`;
							if (change === 'target alias')
								await sql`UPDATE redirects SET alias_title='별칭 변경'`;
							if (change === 'target microsecond')
								await sql`UPDATE documents SET updated_at=updated_at+interval '1 microsecond'`;
							if (change === 'trash restore') {
								await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-01',lifecycle_version=lifecycle_version+1`;
								await sql`UPDATE documents SET deleted_at=NULL,deleted_by=NULL,lifecycle_version=lifecycle_version+1`;
							}
							if (change === 'published') await sql`UPDATE drafts SET status='published'`;
							if (change === 'deleted') await sql`DELETE FROM drafts`;
							afterChange = await snapshot();
						}
					});
					const result = await post(input);
					assert.equal(result.status, 409);
					kept(result, input);
					assert.deepEqual(await snapshot(), afterChange);
					assert.equal((await sql`SELECT id FROM revisions WHERE document_id=${doc.id}`).length, 1);
				});
			for (const kind of [
				'primary',
				'title',
				'alias',
				'legacy alias label',
				'archived primary',
				'archived alias',
				'archived legacy alias label'
			])
				await t.test(`available aliases preserve foreign ${kind} ownership`, async (st) => {
					const { draft } = await seed();
					let other;
					if (kind.includes('primary'))
						[other] =
							await sql`INSERT INTO documents(title,slug,content) VALUES('다른 문서','통합-별칭','다른 원문') RETURNING *`;
					else if (kind === 'title')
						[other] =
							await sql`INSERT INTO documents(title,slug,content) VALUES('통합 별칭','different','다른 원문') RETURNING *`;
					else {
						[other] =
							await sql`INSERT INTO documents(title,slug,content) VALUES('다른 문서','different','다른 원문') RETURNING *`;
						await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${kind.includes('legacy') ? 'legacy-foreign-alias' : '통합-별칭'},'통합 별칭',${other.id})`;
					}
					if (kind.startsWith('archived'))
						await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-01' WHERE id=${other.id}`;
					const before = await snapshot();
					ai(st);
					assert.equal((await post(await fields(draft.id))).status, 303);
					const after = await snapshot();
					assert.deepEqual(
						after.documents.find((d) => String(d.id) === String(other.id)),
						before.documents.find((d) => String(d.id) === String(other.id))
					);
					for (const alias of before.aliases)
						assert.deepEqual(
							after.aliases.find((a) => a.id === alias.id),
							alias
						);
					assert.equal(
						after.aliases.some((a) => a.alias_slug === '장비-점검-개정'),
						true
					);
					assert.equal(
						after.aliases.filter(
							(a) => a.alias_slug === '통합-별칭' && String(a.document_id) !== String(other.id)
						).length,
						0
					);
				});
			await t.test(
				'foreign alias acquired during AI is skipped while the merge still commits',
				async (st) => {
					const { draft } = await seed();
					ai(st, {
						before: async () => {
							const [d] =
								await sql`INSERT INTO documents(title,slug,content) VALUES('다른 문서','different','원문') RETURNING *`;
							await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('장비-점검-개정','장비 점검 개정',${d.id})`;
						}
					});
					assert.equal((await post(await fields(draft.id))).status, 303);
					const rows =
						await sql`SELECT d.slug FROM redirects r JOIN documents d ON d.id=r.document_id WHERE alias_slug='장비-점검-개정'`;
					assert.equal(rows[0].slug, 'different');
				}
			);
			for (const table of ['drafts', 'documents', 'revisions', 'redirects'])
				for (const behavior of ['exception', 'skip'])
					await t.test(
						`${table} ${behavior} rolls the entire application back and supports retry`,
						async () => {
							const { draft } = await seed({
									patchProposal: { id: 'a0101234-5678-4abc-8abc-abcdefabcdef' }
								}),
								input = await fields(draft.id),
								before = await snapshot();
							await sql.unsafe(
								`CREATE FUNCTION fail_application() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${behavior === 'exception' ? "RAISE EXCEPTION 'private-application-error';" : 'RETURN NULL;'} END $$`
							);
							await sql.unsafe(
								`CREATE TRIGGER fail_application BEFORE ${['drafts', 'documents'].includes(table) ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_application()`
							);
							try {
								const result = await post(input);
								assert.equal(result.status, 503);
								kept(result, input);
								assert.deepEqual(await snapshot(), before);
								assert.doesNotMatch(result.data.message, /private-application/);
							} finally {
								await sql.unsafe(`DROP TRIGGER fail_application ON ${table}`);
								await sql`DROP FUNCTION fail_application()`;
							}
							assert.equal((await post(input)).status, 303);
						}
					);
			await t.test('simultaneous reviewed applications save exactly once', async (st) => {
				const { draft } = await seed(),
					input = await fields(draft.id);
				let arrived = 0,
					release;
				const gate = new Promise((r) => (release = r));
				ai(st, {
					before: async () => {
						arrived++;
						if (arrived === 2) release();
						await gate;
					}
				});
				const results = await Promise.all([post(input), post(input)]);
				assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
				assert.equal((await sql`SELECT id FROM revisions`).length, 2);
				assert.equal((await sql`SELECT id FROM redirects`).length, 3);
			});
			await t.test('new publication and merge race produce one publication path', async (st) => {
				const { draft } = await seed(),
					input = await fields(draft.id);
				let arrived = 0,
					release;
				const gate = new Promise((r) => (release = r));
				ai(st, {
					before: async () => {
						arrived++;
						if (arrived === 2) release();
						await gate;
					}
				});
				const normal = { ...input, finalContent: undefined, mergeEditor: undefined };
				const results = await Promise.all([post(input), post(normal, 'publish')]);
				assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
				const current = await snapshot();
				assert.equal(current.revisions.length, 2);
				assert.equal(current.drafts[0].status, 'published');
				assert.equal(current.documents.length, results[0].status === 303 ? 1 : 2);
			});
			await t.test(
				'actual discard winning during inspection prevents application and preserves final input',
				async (st) => {
					const { draft } = await seed(),
						input = await fields(draft.id);
					ai(st, {
						before: async () => {
							assert.equal(
								(
									await post(
										{ ...input, finalContent: undefined, mergeEditor: undefined },
										'discardMerge'
									)
								).status,
								303
							);
						}
					});
					const result = await post(input);
					assert.equal(result.status, 409);
					kept(result, input);
					assert.equal((await sql`SELECT id FROM revisions`).length, 1);
				}
			);
			await t.test(
				'independent committed document edit is rechecked after real lock contention',
				async (st) => {
					const { draft } = await seed(),
						input = await fields(draft.id);
					let ready, release;
					const locked = new Promise((r) => (ready = r)),
						gate = new Promise((r) => (release = r));
					const editing = sql.begin(async (tx) => {
						await tx`UPDATE documents SET content='독립 연결 수정'`;
						ready();
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
					assert.equal((await sql`SELECT content FROM documents`)[0].content, '독립 연결 수정');
				}
			);
			for (const action of ['update', 'publish', 'generateMerge', 'discardMerge'])
				await t.test(`manual final edits survive ${action} without explicit reset`, async (st) => {
					const { draft } = await seed(),
						before = await snapshot(),
						input = { ...(await fields(draft.id)), finalContent: output.content + '\n내 편집' },
						calls = ai(st),
						result = await post(input, action);
					assert.equal(result.status, 400);
					kept(result, input);
					assert.equal(calls.length, 0);
					assert.deepEqual(await snapshot(), before);
					if (action === 'discardMerge') {
						assert.equal((await post({ ...input, confirmResetMerge: 'yes' }, action)).status, 303);
						assert.equal((await getDraft(sql, draft.id)).governance.merge, undefined);
					}
				});
			await t.test(
				'load failure does not reveal DB details or claim successful application',
				async () => {
					const { draft } = await seed(),
						input = await fields(draft.id);
					await sql`ALTER TABLE documents RENAME TO unavailable_documents`;
					try {
						const result = await post(input);
						assert.equal(result.status, 503);
						kept(result, input);
						assert.doesNotMatch(result.data.message, /unavailable_documents/);
					} finally {
						await sql`ALTER TABLE unavailable_documents RENAME TO documents`;
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
