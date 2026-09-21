import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { workbookFile } from './fixtures/office.js';

test(
	'Excel generation timeout preserves existing database rows and same-file retry saves all 32 drafts',
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
					name: 'isolated-timeout-db',
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
			await sql`INSERT INTO documents (title,slug,content,editor_handle) VALUES ('보존 문서','preserved','원래 본문','Editor-01')`;
			await sql`INSERT INTO drafts (title,slug,content,source_name,editor_handle) VALUES ('보존 초안','preserved-draft','원래 초안','original.xlsx','Editor-01')`;
			const beforeDocs = [...(await sql`SELECT * FROM documents`)];
			const beforeDrafts = [...(await sql`SELECT * FROM drafts`)];
			const { POST } = await server.ssrLoadModule('/src/routes/api/wikify/+server.js');
			const file = await workbookFile();
			const upload = () => {
				const body = new FormData();
				body.set('file', file);
				body.set('editor', 'Editor-01');
				return POST({
					request: new Request('http://localhost/api/wikify', { method: 'POST', body })
				});
			};
			const topics = Array.from({ length: 32 }, (_, i) => ({
				title: `가상 약어 ${i + 1}`,
				scope: '원문 정의'
			}));
			let timeout = true;
			let batches = 0;
			let ready;
			const started = new Promise((resolve) => (ready = resolve));
			const deadline = new AbortController();
			t.mock.method(AbortSignal, 'timeout', () =>
				timeout ? deadline.signal : new AbortController().signal
			);
			t.mock.method(globalThis, 'fetch', async (_url, options) => {
				const request = JSON.parse(options.body);
				let value = { passed: true, reasons: [] };
				if (request.text?.format?.name === 'wiki_document_topics') value = { topics };
				if (request.text?.format?.name === 'wiki_documents') {
					batches++;
					if (batches === 4) ready();
					if (timeout && batches === 4)
						await new Promise((_resolve, reject) =>
							options.signal.addEventListener('abort', () => reject(options.signal.reason), {
								once: true
							})
						);
					value = {
						documents: JSON.parse(request.input).topics.map(({ title }) => ({
							title,
							sections: [
								{ heading: '정의', content: '다음 근무자에게 작업 상태를 전하는 예시 기록' }
							],
							aliases: [],
							suggestedLinks: []
						}))
					};
				}
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
			const pending = upload();
			await started;
			deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
			const response = await pending;
			assert.equal(response.status, 504);
			assert.match((await response.json()).message, /초안은 저장하지 않았습니다/);
			assert.deepEqual([...(await sql`SELECT * FROM documents`)], beforeDocs);
			assert.deepEqual([...(await sql`SELECT * FROM drafts`)], beforeDrafts);
			timeout = false;
			const retried = await upload();
			assert.equal(retried.status, 201);
			assert.equal((await retried.json()).count, 32);
			assert.equal(batches, 8);
			assert.deepEqual([...(await sql`SELECT * FROM documents`)], beforeDocs);
			assert.deepEqual(
				[...(await sql`SELECT * FROM drafts WHERE id=${beforeDrafts[0].id}`)],
				beforeDrafts
			);
			assert.equal(
				(await sql`SELECT count(*)::int n FROM drafts WHERE source_name=${file.name}`)[0].n,
				32
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
