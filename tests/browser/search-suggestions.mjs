import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cacheDir = await mkdtemp(resolve(tmpdir(), 'wiki-search-suggestions-'));
// Mount the real component without application servers, credentials, or database access.
const server = await createServer({
	root,
	configFile: false,
	envDir: false,
	cacheDir,
	resolve: { alias: { $lib: root + '/src/lib' } },
	server: { host: '127.0.0.1', port: 4199, strictPort: true, watch: null },
	plugins: [
		svelte({ configFile: false }),
		{
			name: 'search-suggestions-harness',
			resolveId(id) {
				if (id === '$app/navigation') return '\0test-navigation';
			},
			load(id) {
				if (id === '\0test-navigation') return 'export const goto = (url) => location.assign(url);';
			},
			configureServer(server) {
				server.middlewares.use(async (req, res, next) => {
					if (req.url.split('?')[0] !== '/') return next();
					res.setHeader('Content-Type', 'text/html');
					res.end(
						await server.transformIndexHtml(
							'/',
							`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<div id="app"></div><button id="outside">Outside</button>
<script type="module">
import { mount } from 'svelte';
import SearchBox from '/src/lib/components/SearchBox.svelte';
mount(SearchBox, { target: document.querySelector('#app'), props: {
compact: new URLSearchParams(location.search).has('compact')
} });
</script>`
						)
					);
				});
			}
		}
	]
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const base = 'http://127.0.0.1:4199';
const errors = [];
try {
	for (const compact of [false, true]) {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true
		});
		const page = await context.newPage();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.route('**/api/search?*', (route) =>
			route.fulfill({
				json: {
					results: [
						{ slug: 'search-target', title: '테스트 문서', excerpt: '검색 후보', category: '공정' }
					]
				}
			})
		);
		await page.route('**/wiki/search-target', (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: '<h1>Destination</h1>'
			})
		);
		async function search() {
			await page.goto(base + (compact ? '/?compact' : '/'));
			await page.getByRole('combobox').fill('테스');
			await page.getByRole('option').waitFor();
		}
		await search();
		await page.getByRole('option').getByRole('link').tap();
		await page.waitForURL(base + '/wiki/search-target');

		await search();
		// Reproduce mobile browsers that blur without transferring focus to the link.
		await page.evaluate(() => {
			document.querySelector('.suggestions').addEventListener(
				'pointerdown',
				() => {
					document.querySelector('input').blur();
				},
				{ once: true, capture: true }
			);
		});
		await page.getByRole('option').getByRole('link').tap();
		await page.waitForURL(base + '/wiki/search-target', { timeout: 5000 });

		await search();
		await page.locator('#outside').tap();
		assert.equal(await page.getByRole('listbox').count(), 0);
		await search();
		await page.keyboard.press('Escape');
		assert.equal(await page.getByRole('listbox').count(), 0);
		await search();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await page.waitForURL(base + '/wiki/search-target');
		await search();
		await page.keyboard.press('Tab'); // Search button stays inside the component.
		assert.equal(await page.getByRole('listbox').count(), 1);
		await page.keyboard.press('Tab'); // Suggestion link.
		await page.keyboard.press('Enter');
		await page.waitForURL(base + '/wiki/search-target');
		await search();
		await page.locator('#outside').focus();
		assert.equal(await page.getByRole('listbox').count(), 0);
		await context.close();
		console.log(
			`${compact ? 'compact' : 'home'}: touch, null-target blur, outside tap, Escape, keyboard navigation passed`
		);
	}
	assert.deepEqual(errors, []);
} finally {
	await browser.close();
	await server.close();
}
