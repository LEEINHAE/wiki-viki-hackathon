import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test(
	'draft input and final merge previews preserve data and match actual publication',
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
					name: 'isolated-draft-preview',
					enforce: 'pre',
					resolveId(id) {
						if (['$env/dynamic/private', `${lib}/server/db.js`, './db.js'].includes(id))
							return fixture;
					}
				}
			]
		});
		const state = await server.ssrLoadModule(fixture);
		let externalCalls = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			externalCalls++;
			throw new Error('External HTTP disabled');
		});
		try {
			await state.setupDatabase();
			state.env.OPENAI_API_KEY = '';
			const sql = state.db();
			const { POST } = await server.ssrLoadModule('/src/routes/api/preview/+server.js');
			const { renderWiki } = await server.ssrLoadModule('/src/lib/server/wiki.js');
			const { getDraft } = await server.ssrLoadModule('/src/lib/server/draft-write.js');
			const { actions, load } = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			const { getEditableDocument } = await server.ssrLoadModule(
				'/src/lib/server/document-write.js'
			);
			const { createProposal, saveProposal } = await server.ssrLoadModule(
				'/src/lib/server/draft-merge.js'
			);
			const preview = (data) =>
				POST({
					request: new Request('http://local/api/preview', {
						method: 'POST',
						body: JSON.stringify(data)
					})
				});
			const snapshot = async () =>
				(
					await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r)) data`
				)[0].data;
			async function action(name, values) {
				const form = new FormData();
				for (const [key, value] of Object.entries(values)) form.set(key, String(value));
				return actions[name]({
					request: new Request('http://local/drafts?/' + name, { method: 'POST', body: form })
				});
			}
			await t.test(
				'current title, aliases, headings and footnotes match a subsequently saved and published draft',
				async () => {
					await sql`INSERT INTO documents(title,slug,content) VALUES('정기 점검','inspection','기존 문서')`;
					const [row] =
						await sql`INSERT INTO drafts(id,title,slug,content,governance) VALUES(9007199254740993,'원래 초안','old','저장된 본문','{"passed":true}') RETURNING id`;
					const current = await getDraft(sql, row.id);
					const content =
						'## 현재 입력\n\n정기 점검을 확인합니다. [[새 제목]] [[내 별칭]] [[없는 문서]]\n\n### 절차\n\n| 항목 | 값 |\n|---|---|\n| 가 | 나 |\n\n> 인용\n\n`코드` [^one]\n\n![점검 도면](/preview-fixture.svg "도면 제목")\n\n[^one]: 현재 각주';
					const context = { id: row.id, mode: 'edit', title: '새 제목', aliases: '내 별칭' };
					const before = await snapshot();
					const response = await preview({
						content,
						draft: context,
						anchorPrefix: 'draft-edit-',
						showImages: true
					});
					assert.equal(response.status, 200);
					assert.equal(response.headers.get('cache-control'), 'no-store');
					const rendered = await response.json();
					assert.match(rendered.html, /id="draft-edit-section-1"/);
					assert.match(rendered.html, /href="#draft-edit-fn-one"/);
					assert.equal(rendered.toc[1].id, 'draft-edit-section-2');
					assert.match(rendered.html, /data-auto-link="true"/);
					assert.match(
						rendered.html,
						/<img src="\/preview-fixture.svg" alt="점검 도면" title="도면 제목">/
					);
					assert.deepEqual(await snapshot(), before);
					assert.equal((await getDraft(sql, row.id)).version, current.version);
					await assert.rejects(
						action('update', {
							id: row.id,
							version: current.version,
							title: context.title,
							aliases: context.aliases,
							content,
							editor: 'Editor-01'
						}),
						{ status: 303 }
					);
					const saved = await getDraft(sql, row.id);
					await assert.rejects(action('publish', { id: row.id, version: saved.version }), {
						status: 303
					});
					const [published] = await sql`SELECT * FROM documents WHERE slug='새-제목'`;
					assert.equal(published.content.replaceAll('\r\n', '\n'), content);
					assert.equal(
						rendered.html.replaceAll('draft-edit-', ''),
						await renderWiki(published.content, [], {}, { sourceSlug: published.slug })
					);
				}
			);
			await t.test(
				'multiple previews isolate anchors and never load external images or expose raw HTML',
				async () => {
					const content =
						'## 예시\n\n![외부 그림](https://example.invalid/tracker)\n\n<script>bad()</script>\n\npassword=NotARealSecret42! [^note]\n\n[^note]: 각주';
					const before = await snapshot();
					for (const prefix of ['ordinary-', 'final-']) {
						const result = await (
							await preview({
								content,
								draft: { id: '123', mode: 'edit', title: '예시', aliases: '' },
								anchorPrefix: prefix
							})
						).json();
						assert.doesNotMatch(result.html, /<img|<script/i);
						assert.match(result.html, /이미지: 외부 그림/);
						assert.ok(result.html.includes(`id="${prefix}fn-note"`));
						assert.equal(result.toc[0].id, prefix + 'section-1');
					}
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'final input preserves target aliases, skips conflicting reservations and matches actual merge',
				async () => {
					await state.clearDatabase();
					const [targetRow] =
						await sql`INSERT INTO documents(title,slug,content) VALUES('기존 설비','fixed-url','원래 내용') RETURNING id`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('원래-별칭','원래 별칭',${targetRow.id})`;
					await sql`INSERT INTO documents(title,slug,content) VALUES('점유 별칭','other-url','다른 문서')`;
					await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('보관 대상','보관-별칭','보관',NOW(),'Editor-01')`;
					const [draftRow] =
						await sql`INSERT INTO drafts(title,slug,content,aliases,governance) VALUES('통합 초안','통합-초안','초안 본문','["새 별칭","점유 별칭","보관 별칭"]','{"passed":true}') RETURNING id`;
					const draft = await getDraft(sql, draftRow.id),
						target = await getEditableDocument('', targetRow.id);
					const proposal = createProposal(draft, target, {
						model: 'test-only',
						result: { content: 'AI 원안', summary: '교육용 통합', conflicts: [] }
					});
					assert.equal(await saveProposal(sql, draft, target, proposal), true);
					const current = await getDraft(sql, draftRow.id);
					const content =
						'## 최종 입력\n\n[[fixed-url|대표 문서]] [[원래 별칭]] [[통합 초안]] [[새 별칭]] [[점유 별칭]] [[보관 별칭]]\n\n최종 수정 [^note]\n\n![통합 도면](/preview-fixture.svg)\n\n[^note]: 보존할 출처';
					const context = { id: draftRow.id, mode: 'merge', proposalId: proposal.id };
					const before = await snapshot();
					const response = await preview({
						content,
						draft: context,
						anchorPrefix: 'merge-',
						showImages: true
					});
					assert.equal(response.status, 200);
					const rendered = await response.json();
					assert.match(
						rendered.html,
						/%EC%A0%90%EC%9C%A0-%EB%B3%84%EC%B9%AD" class="wiki-link missing"/
					);
					assert.equal((rendered.html.match(/wiki-link missing/g) || []).length, 2);
					assert.match(rendered.html, /<img src="\/preview-fixture.svg" alt="통합 도면">/);
					assert.deepEqual(await snapshot(), before);
					const [claimed] =
						await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('concurrent-alias','Concurrent Alias',${targetRow.id}) RETURNING id`;
					const changedTarget = await snapshot();
					assert.equal((await preview({ content, draft: context })).status, 409);
					assert.deepEqual(await snapshot(), changedTarget);
					await sql`DELETE FROM redirects WHERE id=${claimed.id}`;
					assert.equal((await preview({ content, draft: context })).status, 200);
					await assert.rejects(
						action('applyMerge', {
							id: draftRow.id,
							version: current.version,
							proposalId: proposal.id,
							target: `${proposal.targetId}:${proposal.targetFingerprint}`,
							finalContent: content,
							mergeEditor: 'Editor-01',
							confirmMerge: 'yes'
						}),
						{ status: 303 }
					);
					const published = await getEditableDocument('', targetRow.id);
					assert.equal(published.document.content, content);
					assert.equal(
						rendered.html.replaceAll('merge-', ''),
						await renderWiki(content, [], {}, { sourceSlug: target.document.slug })
					);
					assert.equal((await preview({ content, draft: context })).status, 409);
				}
			);
			await t.test(
				'invalid contexts and stale proposals fail safely; stored comparison uses separate anchors',
				async () => {
					const [row] =
						await sql`INSERT INTO drafts(title,slug,content) VALUES('저장 비교','stored','## 저장된 제목\n\n[^a]\n\n[^a]: 각주') RETURNING id`;
					const before = await snapshot();
					for (const input of [
						{ showImages: 'true' },
						{ showImages: 1 },
						{ showImages: null },
						{ draft: { id: 123, mode: 'edit', title: '제목', aliases: '' } },
						{ draft: { id: row.id, mode: 'wrong' } },
						{ draft: { id: row.id, mode: 'merge' } },
						{ anchorPrefix: '" onclick="bad' },
						{ draft: { id: row.id, mode: 'edit', title: '제목', aliases: null } }
					])
						assert.equal((await preview({ content: '숨겨야 할 오류 입력', ...input })).status, 400);
					const stale = await preview({
						content: '오래된 통합 입력',
						draft: { id: row.id, mode: 'merge', proposalId: 'missing' }
					});
					assert.equal(stale.status, 409);
					assert.doesNotMatch(JSON.stringify(await stale.json()), /오래된 통합 입력|SELECT/);
					const selected = await load({ url: new URL('http://local/drafts?open=' + row.id) });
					assert.ok(selected.previewHtml.includes(`id="draft-${row.id}-stored-section-1"`));
					assert.deepEqual(await snapshot(), before);
				}
			);
			assert.equal(externalCalls, 0);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
