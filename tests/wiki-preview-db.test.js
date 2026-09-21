import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test(
	'current input preview uses published rendering without saving or AI calls',
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
					name: 'isolated-preview',
					enforce: 'pre',
					resolveId(id) {
						if (id === '$env/dynamic/private' || id === `${lib}/server/db.js` || id === './db.js')
							return fixture;
					}
				}
			]
		});
		const state = await server.ssrLoadModule(fixture);
		let externalCalls = 0;
		t.mock.method(globalThis, 'fetch', () => {
			externalCalls++;
			throw new Error('External HTTP disabled');
		});
		try {
			await state.setupDatabase();
			const sql = state.db();
			const { POST } = await server.ssrLoadModule('/src/routes/api/preview/+server.js');
			const { renderWiki, buildToc } = await server.ssrLoadModule('/src/lib/server/wiki.js');
			const [doc] =
				await sql`INSERT INTO documents(title,slug,content) VALUES('장비','장비','저장된 본문') RETURNING *`;
			await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('equipment','Equipment',${doc.id})`;
			await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('보관 장비','보관-장비','보관 본문',NOW(),'Editor-01')`;
			await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
			const before = await sql`SELECT * FROM documents ORDER BY id`;
			async function preview(value, raw = false) {
				return POST({
					request: new Request('http://localhost/api/preview', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: raw ? value : JSON.stringify(value)
					})
				});
			}
			await t.test(
				'headings, numbers, links, aliases, tables and footnotes match published HTML',
				async () => {
					const content =
						'# 현재 입력\n\n[[장비]] [[Equipment|별칭]] [[없는 문서]] [[보관 장비]]\n\n## 절차\n\n1. 첫째\n2. 둘째\n\n| 이름 | 값 |\n|---|---|\n| 가 | 나 |\n\n> 인용\n\n~~취소~~ `코드` [참고](https://example.invalid) [^1]\n\n[^1]: 원문 각주';
					const response = await preview({ content });
					assert.equal(response.status, 200);
					assert.equal(response.headers.get('cache-control'), 'no-store');
					const result = await response.json();
					assert.equal(result.html, await renderWiki(content));
					assert.deepEqual(result.toc, buildToc(content));
					assert.match(result.html, /class="wiki-link "/);
					assert.match(result.html, /class="wiki-link missing"/);
					assert.match(result.html, /<table>/);
					assert.match(result.html, /id="fn-1"/);
					assert.match(result.html, /aria-label="1.1번 문단 링크"/);
				}
			);
			await t.test(
				'raw HTML and script links cannot execute; protected text is only rendered, not sent to AI',
				async () => {
					const response = await preview({
						content:
							'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[실행](javascript:alert%281%29)\n\npassword=NotARealSecret42!'
					});
					assert.equal(response.status, 200);
					const result = await response.json();
					assert.doesNotMatch(result.html, /<script|<img|href="javascript:/i);
					assert.match(result.html, /&lt;script&gt;/);
					assert.match(result.html, /password=NotARealSecret42!/);
				}
			);
			await t.test(
				'empty input clears the preview and malformed input returns a safe error',
				async () => {
					assert.deepEqual(await (await preview({ content: ' \n' })).json(), { html: '', toc: [] });
					for (const value of [null, {}, { content: false }, { content: {} }])
						assert.equal((await preview(value)).status, 400);
					assert.equal((await preview('{broken', true)).status, 400);
				}
			);
			await t.test(
				'database failure does not mislabel unresolved links or expose the source',
				async () => {
					await sql`ALTER TABLE documents RENAME TO preview_unavailable_documents`;
					try {
						const response = await preview({ content: 'private-input [[Equipment]]' });
						assert.equal(response.status, 503);
						assert.equal(response.headers.get('cache-control'), 'no-store');
						assert.doesNotMatch(
							JSON.stringify(await response.json()),
							/private-input|Equipment|relation|SELECT/
						);
					} finally {
						await sql`ALTER TABLE preview_unavailable_documents RENAME TO documents`;
					}
				}
			);
			assert.equal(externalCalls, 0);
			assert.deepEqual(await sql`SELECT * FROM documents ORDER BY id`, before);
			assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 1);
			assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 0);
			assert.equal((await sql`SELECT count(*)::int n FROM redirects`)[0].n, 1);
			await t.test(
				'proposed own aliases and new self links match the successfully saved document',
				async () => {
					const { actions, load } = await server.ssrLoadModule(
						'/src/routes/edit/[slug]/+page.server.js'
					);
					state.env.OPENAI_API_KEY = '';
					const content = '[[장비]] [[Equipment]] [[새 별칭]] [[표시 제목 수정]]';
					const proposed = {
						id: doc.id,
						title: '표시 제목 수정',
						aliases: '새 별칭',
						aliasesFormat: 'lines'
					};
					const response = await preview({ content, document: proposed });
					assert.equal(response.status, 200);
					const { html } = await response.json();
					assert.match(html, /href="\/wiki\/equipment" class="wiki-link missing"/);
					assert.deepEqual((await sql`SELECT * FROM documents WHERE id=${doc.id}`)[0], doc);
					assert.equal((await sql`SELECT alias_slug FROM redirects`)[0].alias_slug, 'equipment');
					const values = await load({ params: { slug: doc.slug } });
					async function save(slug, fields) {
						const form = new FormData();
						for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
						await assert.rejects(
							actions.save({
								params: { slug },
								request: new Request('http://localhost/edit/' + slug, {
									method: 'POST',
									body: form
								})
							}),
							{ status: 303 }
						);
					}
					await save(doc.slug, {
						...proposed,
						documentId: doc.id,
						version: values.version,
						content,
						editor: 'Editor-01'
					});
					assert.equal(html, await renderWiki(content));
					// Legacy alias/direct-URL collisions must retain the actual published target.
					await sql`INSERT INTO documents(title,slug,content) VALUES('별도 게시 문서','새-별칭','다른 본문')`;
					const collision = await (
						await preview({ content: '[[새 별칭]]', document: { ...proposed, aliases: '' } })
					).json();
					assert.doesNotMatch(collision.html, /wiki-link missing/);
					const newContent = '[[새 문서]] [[내 별칭]]';
					const newDocument = {
						id: '',
						title: '새 문서',
						aliases: '내 별칭',
						aliasesFormat: 'lines'
					};
					const created = await (
						await preview({ content: newContent, document: newDocument })
					).json();
					assert.equal(
						(await sql`SELECT count(*)::int n FROM documents WHERE slug='새-문서'`)[0].n,
						0
					);
					await save('new', {
						...newDocument,
						documentId: '',
						version: 'new',
						content: newContent,
						editor: 'Editor-01'
					});
					assert.equal(created.html, await renderWiki(newContent));
					assert.doesNotMatch(created.html, /wiki-link missing/);
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
