import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { readingTableContent } from '../fixtures/reading-tables.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.TABLE_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-reading-tables-')));
const base = 'http://127.0.0.1:4181',
	fixture = root + '/tests/fixtures/governance-database.js';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (!url.startsWith(base + '/')) {
		externalCalls++;
		throw new Error('External HTTP disabled');
	}
	return originalFetch(...args);
};
const server = await createServer({
	root,
	configFile: root + '/vite.config.js',
	envDir: false,
	cacheDir: output + '/browser-cache',
	resolve: { alias: { '$env/dynamic/private': fixture } },
	server: { host: '127.0.0.1', port: 4181, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-navigation-browser',
			enforce: 'pre',
			resolveId(id) {
				if (id === root + '/src/lib/server/db.js' || id === '$lib/server/db.js' || id === './db.js')
					return fixture;
			}
		}
	]
});
const state = await server.ssrLoadModule(fixture);
await state.setupDatabase({ maxConnections: 8 });
state.env.OPENAI_API_KEY = '';
const sql = state.db();
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [],
	reports = [];

const [doc] =
	await sql`INSERT INTO documents(title,slug,content) VALUES('표 탐색','table-check',${readingTableContent}) RETURNING *`;
await sql`INSERT INTO documents(title,slug,content) VALUES('표 참고','table-reference','표가 없는 참고 문서입니다.')`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
const drafts = [];
for (let index = 1; index <= 2; index++) {
	const [draft] =
		await sql`INSERT INTO drafts(title,slug,content,governance) VALUES(${`표 초안 ${index}`},${`table-draft-${index}`},${readingTableContent},'{"passed":true}') RETURNING id`;
	drafts.push(draft);
}
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM revisions d),'redirects',(SELECT jsonb_agg(to_jsonb(d) ORDER BY alias_slug) FROM redirects d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) data`
	)[0].data;
const before = await snapshot();
async function context(width, theme, options = {}) {
	const c = await browser.newContext({
		viewport: { width, height: 1000 },
		reducedMotion: 'reduce',
		...options
	});
	await c.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
	await c.route('**/*', (r) => {
		if (
			!r
				.request()
				.url()
				.startsWith(base + '/')
		) {
			externalCalls++;
			return r.abort();
		}
		return r.continue();
	});
	const p = await c.newPage();
	p.on('pageerror', (e) => errors.push(e.message));
	return { c, p };
}
async function shot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
	await p.screenshot({ path: output + '/' + name + '-viewport.png' });
}
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
// Poll outside the page so verification also works when page JavaScript is disabled.
async function scrollState(region) {
	return region.evaluate((n) => ({
		left: n.scrollLeft,
		width: n.clientWidth,
		full: n.scrollWidth
	}));
}
async function waitForScroll(region, condition) {
	const deadline = Date.now() + 5000;
	let state;
	do {
		state = await scrollState(region);
		if (condition(state)) return;
		await delay(50);
	} while (Date.now() < deadline);
	assert.fail('Unexpected table scroll position: ' + JSON.stringify(state));
}
async function settleScroll(region) {
	let previous = (await scrollState(region)).left,
		stable = 0;
	const deadline = Date.now() + 5000;
	while (stable < 3 && Date.now() < deadline) {
		await delay(50);
		const current = (await scrollState(region)).left;
		stable = Math.abs(current - previous) < 0.1 ? stable + 1 : 0;
		previous = current;
	}
	assert.ok(stable >= 3, 'native scroll animation must finish');
}
async function verifyTable(p, scope, prefix = '') {
	assert.equal(await scope.getByRole('table').count(), 3);
	const regions = scope.getByRole('region', { name: /^표 \d+$/ });
	assert.equal(await regions.count(), 3);
	const wide = regions.first();
	assert.equal(await wide.getByRole('columnheader').count(), 12);
	assert.equal(await wide.getByRole('cell').count(), 24);
	assert.equal(await wide.locator('td[align="center"]').first().innerText(), '가운데 값');
	assert.equal(await regions.nth(1).getByRole('cell').count(), 2);
	assert.equal(await regions.nth(2).getByRole('cell').count(), 0);
	assert.equal(await wide.evaluate((n) => n.scrollWidth > n.clientWidth), true);
	assert.equal(await regions.nth(1).evaluate((n) => n.scrollWidth > n.clientWidth + 1), false);
	assert.equal(await wide.getAttribute('aria-describedby'), prefix + 'table-1-hint');
	await scope.getByRole('link', { name: '표 앞 링크', exact: true }).focus();
	await p.keyboard.press('Tab');
	assert.equal(await p.evaluate(() => document.activeElement.id), prefix + 'table-1');
	assert.notEqual(await wide.evaluate((n) => getComputedStyle(n).outlineStyle), 'none');
	for (let i = 0; i < 40; i++) await p.keyboard.press('ArrowRight');
	await waitForScroll(wide, (n) => n.left >= n.full - n.width - 2);
	await settleScroll(wide);
	const last = await wide.getByRole('cell', { name: '마지막 열 값', exact: true }).boundingBox();
	const box = await wide.boundingBox();
	assert.ok(
		last.x >= box.x && last.x + last.width <= box.x + box.width + 1,
		JSON.stringify({
			last,
			box,
			position: await wide.evaluate((n) => ({
				left: n.scrollLeft,
				width: n.clientWidth,
				full: n.scrollWidth
			}))
		})
	);
	assert.equal(await p.evaluate(() => scrollX), 0);
	await p.keyboard.press('ArrowLeft');
	await waitForScroll(wide, (n) => n.left < n.full - n.width - 4);
	await p.keyboard.press('Tab');
	assert.equal(
		await p.evaluate(() => document.activeElement.getAttribute('href')),
		'/wiki/table-reference'
	);
	await p.keyboard.press('Tab');
	assert.equal(
		await p.evaluate(() => document.activeElement.getAttribute('href')),
		'#' + prefix + 'fn-table'
	);
	await p.keyboard.press('Tab');
	assert.equal(await p.evaluate(() => document.activeElement.textContent), '표 뒤 링크');
	await wide.focus();
	await p.keyboard.press('Shift+Tab');
	assert.equal(await p.evaluate(() => document.activeElement.textContent), '표 앞 링크');
	await p.keyboard.press('Tab');
	await wide.locator('.footnote-ref a').focus();
	await p.keyboard.press('Enter');
	assert.equal(await p.evaluate(() => document.activeElement.id), prefix + 'fn-table');
	await scope.locator('.footnote-backlink').focus();
	await p.keyboard.press('Enter');
	assert.equal(await p.evaluate(() => document.activeElement.id), prefix + 'fnref-table-1');
	const refBox = await wide.locator('.footnote-ref a').boundingBox();
	const regionBox = await wide.boundingBox();
	assert.ok(refBox.x >= regionBox.x && refBox.x + refBox.width <= regionBox.x + regionBox.width);
	await noOverflow(p);
}
async function preview(p) {
	await p.locator('.preview-panel').waitFor({ state: 'attached' });
	const tab = p.getByRole('tab', { name: '미리보기', exact: true });
	if (await tab.count()) await tab.click();
	await p.locator('.preview-panel table').first().waitFor();
	return p.locator('.preview-panel .wiki-content');
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + '/wiki/table-check', { waitUntil: 'networkidle' });
			await shot(p, `initial-${width}-${theme}`);
			await writeFile(
				output + `/structure-${width}-${theme}.json`,
				JSON.stringify(
					await p.locator('.wiki-content table').evaluateAll((tables) =>
						tables.map((table) => ({
							width: table.clientWidth,
							scrollWidth: table.scrollWidth,
							tabIndex: table.getAttribute('tabindex'),
							scrollRegion: !!table.closest('.wiki-table-scroll')
						}))
					),
					null,
					2
				)
			);
			await verifyTable(p, p.locator('.wiki-content'));
			await shot(p, `keyboard-${width}-${theme}`);
			const html = await p.locator('.wiki-content').innerHTML();
			await p.goto(base + '/edit/table-check', { waitUntil: 'networkidle' });
			const editor = await preview(p);
			await verifyTable(p, editor);
			// SSR includes Svelte hydration comments; compare all visible markup and attributes.
			const withoutComments = (value) => value.replace(/<!--[\s\S]*?-->/g, '');
			assert.equal(withoutComments(await editor.innerHTML()), withoutComments(html));
			assert.equal(
				await p.getByLabel('위키 본문', { exact: true }).inputValue(),
				readingTableContent
			);
			await shot(p, `preview-${width}-${theme}`);
			await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
			const expand = p.getByRole('button', { name: /^본문 전체 보기/ });
			const count = await expand.count();
			for (let i = 0; i < count; i++) await expand.first().click();
			for (const draft of drafts)
				await verifyTable(p, p.locator(`#review-body-${draft.id}`), `draft-${draft.id}-`);
			const ids = await p.locator('[id]').evaluateAll((nodes) => nodes.map((n) => n.id));
			assert.equal(ids.length, new Set(ids).size);
			await shot(p, `drafts-${width}-${theme}`);
			await c.close();
			reports.push({
				width,
				theme,
				readerAndPreview: 'same HTML and real cells',
				keyboard: 'Tab, both arrows, all columns and exit',
				drafts: 'independent regions and descriptions'
			});
		}
	for (const width of [360, 1440]) {
		const native = await context(width, 'light', { javaScriptEnabled: false });
		await native.p.goto(base + '/wiki/table-check');
		await verifyTable(native.p, native.p.locator('.wiki-content'));
		await native.c.close();
	}
	reports.push({ noJavaScript: 'native table keyboard scrolling and links' });
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/wiki/table-check', { waitUntil: 'networkidle' });
		await verifyTable(zoom.p, zoom.p.locator('.wiki-content'));
		await shot(zoom.p, 'zoom200-' + theme);
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200 });
	const touch = await context(360, 'light', { isMobile: true, hasTouch: true });
	await touch.p.goto(base + '/wiki/table-check', { waitUntil: 'networkidle' });
	const region = touch.p.locator('.wiki-table-scroll').first();
	await region.scrollIntoViewIfNeeded();
	const box = await region.boundingBox();
	const client = await touch.c.newCDPSession(touch.p);
	const y = Math.min(box.y + box.height / 2, 800);
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: box.x + box.width - 20, y }]
	});
	for (let i = 1; i <= 8; i++)
		await client.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: box.x + box.width - 20 - ((box.width - 40) * i) / 8, y }]
		});
	await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await touch.p.waitForFunction(() => document.querySelector('.wiki-table-scroll').scrollLeft > 20);
	await noOverflow(touch.p);
	await shot(touch.p, 'touch-scroll');
	await touch.c.close();
	reports.push({ touch: 'actual browser touch gesture moves only the table horizontally' });
	const empty = await context(360, 'light');
	await empty.p.goto(base + '/wiki/table-reference', { waitUntil: 'networkidle' });
	assert.equal(await empty.p.locator('.wiki-table,.wiki-table-hint').count(), 0);
	await empty.c.close();
	reports.push({ noTable: 'no invented table or guidance' });
	const pending = await context(1440, 'dark');
	await pending.p.goto(base + '/edit/table-check', { waitUntil: 'networkidle' });
	await preview(pending.p);
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	await pending.p.route('**/api/preview', async (route) => {
		await gate;
		await route.continue();
	});
	const request = pending.p.waitForRequest('**/api/preview');
	const updated = readingTableContent.replace('마지막 열 값', '수정 열 값');
	await pending.p.getByLabel('위키 본문', { exact: true }).fill(updated);
	await request;
	try {
		await pending.p.getByText('현재 입력을 미리보기로 바꾸고 있습니다…', { exact: true }).waitFor();
		assert.equal(await pending.p.locator('.preview-panel .wiki-table').count(), 0);
		assert.equal(await pending.p.getByLabel('위키 본문', { exact: true }).inputValue(), updated);
		await shot(pending.p, 'loading-preview');
	} finally {
		release();
	}
	await pending.p.getByRole('cell', { name: '수정 열 값', exact: true }).waitFor();
	await pending.p.getByLabel('위키 본문', { exact: true }).fill('');
	await pending.p.getByText('본문을 입력하면 미리보기가 표시됩니다.', { exact: true }).waitFor();
	assert.equal(
		await pending.p.locator('.preview-panel .wiki-table,.preview-panel .wiki-table-hint').count(),
		0
	);
	await pending.c.close();
	reports.push({
		previewStates:
			'actual pending request hides stale table; new values and empty input render without writes'
	});
	const failure = await context(360, 'dark');
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		const response = await failure.p.goto(base + '/wiki/table-check', { waitUntil: 'networkidle' });
		assert.equal(response.status(), 503);
		assert.equal(await failure.p.locator('.wiki-table').count(), 0);
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await failure.p.getByRole('link', { name: '다시 불러오기', exact: true }).click();
	await failure.p.locator('.wiki-table').first().waitFor();
	await verifyTable(failure.p, failure.p.locator('.wiki-content'));
	await failure.c.close();
	reports.push({ databaseFailure: 'actual read failure followed by explicit retry' });
	assert.deepEqual(await snapshot(), before);
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, unchangedDatabase: true, output };
	await writeFile(output + '/table-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
