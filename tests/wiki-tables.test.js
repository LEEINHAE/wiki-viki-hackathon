import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createLinkCatalog } from '../src/lib/wiki-links.js';
import { readingTableContent } from './fixtures/reading-tables.js';

test('table navigation preserves real cells, links and isolated preview anchors', async (t) => {
	const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
	const fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
	const server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, ws: false, watch: null },
		resolve: { alias: { $lib: lib } },
		plugins: [
			{
				name: 'table-renderer',
				enforce: 'pre',
				resolveId(id) {
					if (['$env/dynamic/private', `${lib}/server/db.js`, './db.js'].includes(id))
						return fixture;
				}
			}
		]
	});
	let externalCalls = 0;
	t.mock.method(globalThis, 'fetch', () => {
		externalCalls++;
		throw new Error('External HTTP disabled');
	});
	try {
		const { renderWiki } = await server.ssrLoadModule('/src/lib/server/wiki.js');
		const catalog = createLinkCatalog([{ id: 1, title: '표 참고', slug: 'table-reference' }]);
		const render = (source, options = {}) => renderWiki(source, [], {}, { catalog, ...options });
		await t.test(
			'each real table is a named keyboard region and keeps header, body, alignment and links',
			async () => {
				const html = await render(readingTableContent);
				assert.equal(html.match(/class="wiki-table-scroll"/g)?.length, 3);
				for (let n = 1; n <= 3; n++) {
					assert.match(
						html,
						new RegExp(
							`id="table-${n}"[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label="표 ${n}"[^>]*aria-describedby="table-${n}-hint"`
						)
					);
					assert.match(html, new RegExp(`id="table-${n}-hint"`));
				}
				assert.equal(html.match(/<table>/g)?.length, 3);
				assert.equal(html.match(/<th(?:\s|>)/g)?.length, 16);
				assert.equal(html.match(/<td(?:\s|>)/g)?.length, 26);
				assert.match(html, /<td align="center"><strong>가운데 값<\/strong><\/td>/);
				assert.match(html, /<td align="right">42<\/td>/);
				assert.match(html, /href="\/wiki\/table-reference"/);
				assert.match(html, /<code>점검<\/code>/);
				assert.match(html, /href="#fn-table"/);
			}
		);
		await t.test(
			'drafts and merge previews have distinct description IDs without changing table values',
			async () => {
				const source = await render(readingTableContent);
				const tables = (html) => [...html.matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => m[0]);
				for (const prefix of ['draft-1-', 'draft-1-edit-', 'draft-1-merge-']) {
					const html = await render(readingTableContent, { anchorPrefix: prefix });
					assert.match(html, new RegExp(`aria-describedby="${prefix}table-1-hint"`));
					assert.match(html, new RegExp(`id="${prefix}table-1-hint"`));
					assert.deepEqual(tables(html.replaceAll(prefix, '')), tables(source));
					const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
					assert.equal(ids.length, new Set(ids).size);
				}
			}
		);
		await t.test(
			'plain text and code create no fake table and raw markup remains escaped',
			async () => {
				assert.doesNotMatch(
					await render('본문만 있습니다.\n\n```text\n| A | B |\n| --- | --- |\n```'),
					/wiki-table|<table>/
				);
				const html = await render('| 항목 |\n| --- |\n| <img src=x onerror=alert(1)> |');
				assert.doesNotMatch(html, /<img/);
				assert.match(html, /&lt;img/);
			}
		);
		assert.equal(externalCalls, 0);
	} finally {
		await server.close();
	}
});
