import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { seedReadingConnections, longConnectionLabel } from '../fixtures/reading-connections.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.CONNECTION_BROWSER_OUTPUT ||
	(await mkdtemp(resolve(tmpdir(), 'wiki-reading-connections-')));
const base = 'http://127.0.0.1:4180',
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
	server: { host: '127.0.0.1', port: 4180, strictPort: true, watch: null },
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

const docs = await seedReadingConnections(sql);
const { getEditableDocument } = await server.ssrLoadModule('/src/lib/server/document-write.js');
const { changeDocumentTrash } = await server.ssrLoadModule('/src/lib/server/document-trash.js');
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM revisions d),'redirects',(SELECT jsonb_agg(to_jsonb(d) ORDER BY alias_slug) FROM redirects d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) data`
	)[0].data;
const before = await snapshot();
const related = (p) => p.locator('[aria-labelledby="related-title"]');
const incoming = (p) => p.locator('.backlinks');
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
	p.on('dialog', async (dialog) => {
		errors.push('Unexpected dialog: ' + dialog.type());
		await dialog.dismiss();
	});
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
async function verify(p) {
	assert.equal(await related(p).locator('.connection-link').count(), 3);
	assert.equal(await incoming(p).locator('.connection-link').count(), 2);
	assert.match(await related(p).innerText(), /이 문서의 본문에서 연결한 문서/);
	assert.match(await incoming(p).innerText(), /아래 문서의 본문에서 이 문서로/);
	assert.equal(
		await related(p).locator('.connection-reason').filter({ hasText: '공정 별칭' }).innerText(),
		'제목·별칭 자동 연결\n본문 표기: “공정 별칭”'
	);
	assert.equal(
		await related(p).locator('.connection-reason').filter({ hasText: '저장된 안내' }).innerText(),
		'본문에 저장된 링크\n본문 표기: “저장된 안내”'
	);
	assert.ok((await related(p).innerText()).includes(longConnectionLabel));
	assert.equal(
		await p.locator('.document-connections img,.document-connections script').count(),
		0
	);
	const ids = await p.locator('[id]').evaluateAll((nodes) => nodes.map((n) => n.id));
	assert.equal(ids.length, new Set(ids).size);
	for (const link of await p.locator('.document-connections a').all()) {
		const description = await link.getAttribute('aria-describedby');
		assert.equal(await p.locator(`[id="${description}"]`).count(), 1);
		assert.ok((await p.locator(`[id="${description}"]`).innerText()).length > 5);
	}
	const counts = await p
		.locator('.article-info dl > div')
		.evaluateAll((nodes) =>
			Object.fromEntries(
				nodes.map((n) => [n.querySelector('dt').textContent, n.querySelector('dd').textContent])
			)
		);
	assert.equal(counts['이 문서로 연결'], '2개');
	assert.equal(counts['이 문서에서 연결'], '3개');
	if (p.viewportSize().width <= 800) {
		const main = await p.locator('.article-main').boundingBox();
		const aside = await p.locator('.article-aside').boundingBox();
		assert.ok(aside.y >= main.y + main.height);
	}
	await noOverflow(p);
}
async function keyboardVisit(p) {
	const target = related(p).getByRole('link', { name: 'RFCC', exact: true });
	await target.focus();
	await p.keyboard.press('Shift+Tab');
	await p.keyboard.press('Tab');
	assert.equal(await target.evaluate((n) => n === document.activeElement), true);
	assert.notEqual(await target.evaluate((n) => getComputedStyle(n).outlineStyle), 'none');
	await p.keyboard.press('Enter');
	await p.waitForURL(base + '/wiki/fixed-rfcc');
	await p.getByRole('heading', { name: 'RFCC', exact: true }).waitFor();
	assert.match(await incoming(p).innerText(), /본문 표기: “공정 별칭”/);
	await incoming(p).getByRole('link', { name: '교대 기록 ↗', exact: true }).focus();
	await p.keyboard.press('Enter');
	await p.waitForURL(base + '/wiki/reading-connections');
	await related(p).getByRole('link', { name: '정비 절차', exact: true }).focus();
	await p.keyboard.press('Enter');
	await p.waitForURL(base + '/wiki/guide');
	assert.match(await incoming(p).innerText(), /본문에 저장된 링크/);
	await incoming(p).getByRole('link', { name: '교대 기록 ↗', exact: true }).click();
	await p.waitForURL(base + '/wiki/reading-connections');
	await incoming(p).getByRole('link', { name: '자동 참조 ↗', exact: true }).focus();
	await p.keyboard.press('Enter');
	await p.waitForURL(base + '/wiki/incoming-auto');
	assert.equal(
		await related(p).getByRole('link', { name: '교대 기록', exact: true }).getAttribute('href'),
		'/wiki/reading-connections'
	);
	await related(p).getByRole('link', { name: '교대 기록', exact: true }).click();
	await p.waitForURL(base + '/wiki/reading-connections');
	await verify(p);
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + '/wiki/old-handover', { waitUntil: 'networkidle' });
			assert.match(await p.locator('.redirect-notice').innerText(), /기록 별칭/);
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			await verify(p);
			await incoming(p).getByRole('heading').scrollIntoViewIfNeeded();
			await shot(p, `incoming-${width}-${theme}`);
			await related(p).getByRole('link', { name: 'RFCC', exact: true }).focus();
			await shot(p, `outgoing-${width}-${theme}`);
			await keyboardVisit(p);
			await c.close();
			reports.push({
				width,
				theme,
				reasons: 'automatic aliases and stored links with actual source labels',
				navigation: 'keyboard round trips through canonical targets and incoming source',
				preserved: true
			});
		}
	for (const width of [360, 1440]) {
		const native = await context(width, 'light', { javaScriptEnabled: false });
		await native.p.goto(base + '/wiki/reading-connections');
		await verify(native.p);
		await keyboardVisit(native.p);
		await native.c.close();
	}
	reports.push({ noJavaScript: 'complete native link navigation and reasons' });
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/wiki/reading-connections', { waitUntil: 'networkidle' });
		await verify(zoom.p);
		await related(zoom.p).getByRole('link', { name: 'RFCC', exact: true }).focus();
		await shot(zoom.p, 'zoom200-' + theme);
		await keyboardVisit(zoom.p);
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200 });
	const empty = await context(360, 'light');
	await empty.p.goto(base + '/wiki/isolated', { waitUntil: 'networkidle' });
	assert.equal(await empty.p.locator('.document-connections').count(), 0);
	assert.match(await incoming(empty.p).innerText(), /아직 이 문서를 가리키는 문서가 없습니다/);
	assert.match(await related(empty.p).innerText(), /본문에 다른 문서의 제목이나 별칭/);
	await shot(empty.p, 'empty');
	await empty.c.close();
	reports.push({ empty: 'actual isolated document without invented reasons' });
	const pending = await context(360, 'dark');
	await pending.p.goto(base + '/wiki/fixed-rfcc', { waitUntil: 'networkidle' });
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	await pending.p.route('**/wiki/reading-connections/__data.json*', async (route) => {
		await gate;
		await route.continue();
	});
	await incoming(pending.p).getByRole('link', { name: '교대 기록 ↗', exact: true }).focus();
	const requested = pending.p.waitForRequest('**/wiki/reading-connections/__data.json*');
	const move = pending.p.keyboard.press('Enter');
	await requested;
	try {
		await pending.p.getByRole('heading', { name: 'RFCC', exact: true }).waitFor();
		assert.equal(await incoming(pending.p).locator('.connection-link').count(), 1);
		assert.equal(await related(pending.p).locator('.connection-link').count(), 0);
	} finally {
		release();
	}
	await move;
	await pending.p.getByRole('heading', { name: '교대 기록', exact: true }).waitFor();
	await verify(pending.p);
	await pending.c.close();
	reports.push({
		loading: 'previous document and its real connections remain until the next response arrives'
	});
	const failure = await context(360, 'dark');
	await sql`ALTER TABLE redirects RENAME TO redirects_unavailable`;
	try {
		const response = await failure.p.goto(base + '/wiki/reading-connections', {
			waitUntil: 'networkidle'
		});
		assert.equal(response.status(), 500);
		assert.equal(
			await failure.p.locator('.document-connections,#related-title,#backlinks-title').count(),
			0
		);
		await shot(failure.p, 'error');
	} finally {
		await sql`ALTER TABLE redirects_unavailable RENAME TO redirects`;
	}
	await failure.p.getByRole('link', { name: '다시 불러오기', exact: true }).click();
	await related(failure.p).waitFor();
	await verify(failure.p);
	await failure.c.close();
	reports.push({
		databaseFailure: 'actual snapshot failure is an error, not empty links; explicit retry recovers'
	});
	assert.deepEqual(await snapshot(), before);
	const lifecycle = await context(360, 'light');
	const expected = structuredClone(before);
	for (const [target, direction, count] of [
		[docs.manual, related, 3],
		[docs.incomingAuto, incoming, 2]
	]) {
		assert.equal(
			(
				await changeDocumentTrash({
					expected: await getEditableDocument(target.slug),
					deleted: true
				})
			).status,
			'trashed'
		);
		await lifecycle.p.goto(base + '/wiki/reading-connections', { waitUntil: 'networkidle' });
		assert.equal(await direction(lifecycle.p).locator('.connection-link').count(), count - 1);
		assert.equal(await direction(lifecycle.p).locator(`a[href="/wiki/${target.slug}"]`).count(), 0);
		assert.equal(
			(
				await changeDocumentTrash({
					expected: await getEditableDocument('', target.id, { includeDeleted: true }),
					deleted: false
				})
			).status,
			'restored'
		);
		await lifecycle.p.reload({ waitUntil: 'networkidle' });
		await verify(lifecycle.p);
		expected.documents.find((d) => String(d.id) === String(target.id)).lifecycle_version += 2;
	}
	await lifecycle.c.close();
	assert.deepEqual(await snapshot(), expected);
	reports.push({
		lifecycle:
			'actual trash/restore removes and restores both directions; only intended lifecycle counters change'
	});
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = {
		reports,
		errors,
		externalCalls,
		readsPreserveData: true,
		lifecyclePreservesContentAndRelations: true,
		output
	};
	await writeFile(output + '/connection-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
