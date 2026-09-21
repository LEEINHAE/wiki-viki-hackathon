import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createLinkCatalog } from '../src/lib/wiki-links.js';

test('footnotes return to real source references without database or external calls', async (t) => {
	const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
	const fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
	const server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, ws: false, watch: null },
		resolve: { alias: { $lib: lib } },
		plugins: [
			{
				name: 'footnote-renderer',
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
		const render = (source, options = {}) =>
			renderWiki(source, [], {}, { catalog: createLinkCatalog([]), ...options });
		await t.test(
			'repeated references have distinct return targets and preserve the old note anchor',
			async () => {
				const html = await render('첫째[^1]와 둘째[^1].\n\n[^1]: 같은 근거');
				assert.match(html, /id="fn-1"/);
				for (const id of ['fnref-1-1', 'fnref-1-2']) {
					assert.equal(html.split(`id="${id}"`).length - 1, 1);
					assert.match(html, new RegExp(`href="#${id}"`));
				}
				assert.equal(html.match(/class="footnote-backlink"/g)?.length, 2);
				assert.match(html, /각주 1의 2번째 참조로 돌아가기/);
			}
		);
		await t.test('preview prefixes keep note and return IDs independent', async () => {
			const source = '같은 표기[^same]\n\n[^same]: 같은 근거';
			for (const prefix of ['draft-edit-', 'merge-']) {
				const html = await render(source, { anchorPrefix: prefix });
				for (const id of ['fn-same', 'fnref-same-1']) {
					assert.match(html, new RegExp(`id="${prefix}${id}"`));
					assert.match(html, new RegExp(`href="#${prefix}${id}"`));
				}
				assert.doesNotMatch(html, /(?:id|href)="#?fn(?:ref)?-/);
			}
		});
		await t.test(
			'normalized collisions, colons and Korean identifiers resolve without duplicate IDs',
			async () => {
				const html = await render(
					'하나[^A B], 둘[^a_b], 셋[^근거:1].\n\n[^A B]: 첫 근거\n[^a_b]: 두 번째 근거\n[^근거:1]: 한글 근거'
				);
				const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
				assert.equal(ids.length, new Set(ids).size);
				assert.ok(ids.includes('fn-a-b'));
				assert.ok(ids.includes('fn-a-b--2'));
				assert.ok(ids.includes('fn-근거:1'));
				assert.equal(html.match(/class="footnote-backlink"/g)?.length, 3);
				for (const [, href] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(href));
			}
		);
		await t.test(
			'code, escaped references, existing links and raw HTML do not create return locations',
			async () => {
				const html = await render(
					'실제[^n]\n\n`[^n]`\n\n```text\n[^n]\n```\n\n\\[^n] [링크[^n]](https://example.invalid) <span title="[^n]">문자</span>\n\n[^n]: 설명'
				);
				assert.equal(html.match(/class="footnote-ref"/g)?.length, 1);
				assert.equal(html.match(/class="footnote-backlink"/g)?.length, 1);
				assert.match(html, /<code>\[\^n\]<\/code>/);
				assert.doesNotMatch(html, /@@WIKIFOOTNOTE/);
			}
		);
		await t.test(
			'unresolved references and unused definitions have no invented return links',
			async () => {
				const html = await render('없는 근거[^missing]\n\n[^unused]: 아직 인용하지 않은 근거');
				assert.match(html, /\[\^missing\]/);
				assert.match(html, /id="fn-unused"/);
				assert.doesNotMatch(html, /footnote-backlink|id="fnref-|href="#fn-missing"/);
				assert.doesNotMatch(await render('각주 없는 설명'), /class="footnotes"/);
			}
		);
		await t.test(
			'source markers and note HTML cannot forge references or executable markup',
			async () => {
				const source =
					'@@WIKIFOOTNOTE:1:1@@ 실제[^1]\n\n[^1]: <img src=x onerror=alert(1)> & "설명"';
				const html = await render(source);
				assert.equal(html.match(/class="footnote-ref"/g)?.length, 1);
				assert.match(html, /@@WIKIFOOTNOTE:1:1@@/);
				assert.doesNotMatch(html, /<img|<script|onerror="/);
				assert.match(html, /&lt;img/);
				assert.equal(html, await render(source));
			}
		);
		assert.equal(externalCalls, 0);
	} finally {
		await server.close();
	}
});
