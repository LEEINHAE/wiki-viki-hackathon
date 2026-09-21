import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.NAVIGATION_BROWSER_OUTPUT ||
	(await mkdtemp(resolve(tmpdir(), 'wiki-mobile-navigation-')));
const base = 'http://127.0.0.1:4187',
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
	server: { host: '127.0.0.1', port: 4187, strictPort: true, watch: null },
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
	await sql`INSERT INTO documents(title,slug,content) VALUES('메뉴 검증','navigation-check','## 인계 안내\n\n가상 교육 문서입니다.') RETURNING *`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
await sql`INSERT INTO drafts(title,slug,content,governance) VALUES('검토 대기','nav-draft','가상 초안','{"passed":true}')`;
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
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
const menu = (p) => p.locator('.mobile-menu');
const summary = (p) => menu(p).locator('summary');
async function opened(p, value) {
	await p.waitForFunction((value) => document.querySelector('.mobile-menu')?.open === value, value);
}
async function open(p) {
	if (await summary(p).isVisible()) {
		if (!(await menu(p).evaluate((e) => e.open))) {
			await summary(p).focus();
			await p.keyboard.press('Space');
		}
		await opened(p, true);
	}
}
async function shot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
	await p.screenshot({ path: output + '/' + name + '-viewport.png' });
}
// Chromium exposes native summary as DisclosureTriangle, not an ARIA button.
async function disclosureState(p, expanded) {
	const session = await p.context().newCDPSession(p);
	const tree = await session.send('Accessibility.getFullAXTree');
	await session.detach();
	const node = tree.nodes.find(
		(node) => node.role?.value === 'DisclosureTriangle' && node.name?.value === '메뉴'
	);
	assert.ok(node && !node.ignored);
	assert.equal(
		node.properties.find((property) => property.name === 'expanded')?.value.value,
		expanded
	);
	assert.equal(
		node.properties.find((property) => property.name === 'focusable')?.value.value,
		true
	);
}
async function layout(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
			await shot(p, 'closed-' + width + '-' + theme);
			assert.equal(await menu(p).count(), 1, 'mobile menu must exist');
			const mobile = width <= 800;
			assert.equal(await summary(p).isVisible(), mobile);
			assert.equal(
				await p.getByRole('navigation', { name: '주요 메뉴', exact: true }).count(),
				mobile ? 0 : 1
			);
			assert.equal(
				await p.getByRole('combobox', { name: '용어 검색', exact: true }).isVisible(),
				true
			);
			const closedHeight = await p
				.locator('.topbar')
				.evaluate((e) => e.getBoundingClientRect().height);
			assert.ok(closedHeight < 140);
			if (mobile) {
				await open(p);
				await disclosureState(p, true);
				await p.keyboard.press('Tab');
				assert.equal(
					await p
						.getByRole('link', { name: '검색', exact: true })
						.evaluate((e) => e === document.activeElement),
					true
				);
				await shot(p, 'open-' + width + '-' + theme);
				await p.keyboard.press('Escape');
				await opened(p, false);
				await disclosureState(p, false);
				assert.equal(await summary(p).evaluate((e) => e === document.activeElement), true);
				await p.keyboard.press('Tab');
				assert.equal(await menu(p).evaluate((e) => e.contains(document.activeElement)), false);
				await open(p);
				await p.getByRole('combobox', { name: '용어 검색', exact: true }).focus();
				await opened(p, false);
			}
			await open(p);
			const link = p.getByRole('link', { name: 'AI 위키파이어', exact: true });
			await link.focus();
			await p.keyboard.press('Enter');
			const dialog = p.getByRole('dialog', { name: 'AI 위키파이어', exact: true });
			await dialog.waitFor();
			await p.keyboard.press('Escape');
			await dialog.waitFor({ state: 'hidden' });
			assert.equal(await link.evaluate((e) => e === document.activeElement), true);
			if (mobile) {
				await opened(p, true);
				await p.keyboard.press('Escape');
				await opened(p, false);
			}
			await open(p);
			await p.getByRole('link', { name: '초안 검토', exact: true }).click();
			await p.waitForURL(base + '/drafts');
			await opened(p, false);
			await open(p);
			assert.equal(
				await p.getByRole('link', { name: '초안 검토', exact: true }).getAttribute('aria-current'),
				'page'
			);
			const search = p.getByRole('combobox', { name: '용어 검색', exact: true });
			await search.fill('메뉴');
			await p.keyboard.press('Enter');
			await p.waitForURL('**/?q=*');
			await opened(p, false);
			await p.getByRole('heading', { name: '「메뉴」 검색 결과', exact: true }).waitFor();
			await layout(p);
			await p.goBack();
			await p.getByRole('heading', { name: '초안 한눈에 검토', exact: true }).waitFor();
			await opened(p, false);
			await c.close();
			reports.push({
				width,
				theme,
				closedHeight,
				nativeDisclosure: mobile,
				escape: mobile,
				modalFocus: true,
				navigation: true,
				search: true,
				back: true
			});
		}
	// Crossing the breakpoint must not leave keyboard focus in hidden navigation.
	const resize = await context(1440, 'light');
	await resize.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
	await resize.p.getByRole('link', { name: '자동 연결', exact: true }).focus();
	await resize.p.setViewportSize({ width: 360, height: 1000 });
	await opened(resize.p, false);
	await summary(resize.p).waitFor();
	await resize.p.waitForFunction(
		() => document.activeElement === document.querySelector('.mobile-menu summary')
	);
	assert.equal(await summary(resize.p).evaluate((e) => e === document.activeElement), true);
	await open(resize.p);
	await resize.p.getByRole('link', { name: '자동 연결', exact: true }).focus();
	await resize.p.setViewportSize({ width: 1440, height: 1000 });
	await resize.p.locator('.desktop-nav').waitFor();
	await resize.p.waitForFunction(
		() => document.activeElement === document.querySelector('.desktop-nav a[href="/links"]')
	);
	assert.equal(
		await resize.p
			.locator('.desktop-nav')
			.getByRole('link', { name: '자동 연결', exact: true })
			.evaluate((e) => e === document.activeElement),
		true
	);
	await resize.c.close();
	reports.push({ resizeFocus: true });
	// A dialog must keep focus while resizing and return to visible navigation when closed.
	for (const width of [360, 1440]) {
		const modal = await context(width, 'light');
		await modal.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
		await open(modal.p);
		await modal.p.getByRole('link', { name: 'AI 위키파이어', exact: true }).focus();
		await modal.p.keyboard.press('Enter');
		const dialog = modal.p.getByRole('dialog', { name: 'AI 위키파이어', exact: true });
		await dialog.waitFor();
		const target = width === 360 ? 1440 : 360;
		await modal.p.setViewportSize({ width: target, height: 1000 });
		await modal.p.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		);
		assert.equal(await dialog.evaluate((e) => e.contains(document.activeElement)), true);
		await modal.p.keyboard.press('Escape');
		await dialog.waitFor({ state: 'hidden' });
		const selector = target === 360 ? '.mobile-menu summary' : '.desktop-nav a[href="/wikify"]';
		await modal.p.waitForFunction(
			(selector) => document.activeElement === document.querySelector(selector),
			selector
		);
		assert.equal(
			await modal.p.locator(selector).evaluate((e) => e === document.activeElement),
			true
		);
		await modal.c.close();
	}
	reports.push({ modalResizeFocus: 'dialog retains focus; close returns to visible navigation' });
	// Closing a menu must not bypass the editor's leave confirmation.
	const dirty = await context(360, 'dark');
	await dirty.p.goto(base + '/edit/navigation-check', { waitUntil: 'networkidle' });
	await dirty.p.getByLabel('위키 본문', { exact: true }).fill('메뉴 이동 전 보존할 미저장 입력');
	await open(dirty.p);
	const dismissed = dirty.p.waitForEvent('dialog').then((d) => d.dismiss());
	await dirty.p.getByRole('link', { name: '초안 검토', exact: true }).click();
	await dismissed;
	assert.equal(new URL(dirty.p.url()).pathname, '/edit/navigation-check');
	await opened(dirty.p, true);
	assert.equal(
		await dirty.p.getByLabel('위키 본문', { exact: true }).inputValue(),
		'메뉴 이동 전 보존할 미저장 입력'
	);
	await shot(dirty.p, 'cancelled-navigation');
	const accepted = dirty.p.waitForEvent('dialog').then((d) => d.accept());
	await dirty.p.getByRole('link', { name: '초안 검토', exact: true }).click();
	await accepted;
	await dirty.p.waitForURL(base + '/drafts');
	await opened(dirty.p, false);
	await dirty.c.close();
	reports.push({
		cancelledNavigation: 'input and open menu preserved',
		acceptedNavigation: 'menu closed; document not saved'
	});
	const delayed = await context(360, 'light');
	await delayed.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	await delayed.p.route('**/drafts/__data.json*', async (route) => {
		await gate;
		await route.continue();
	});
	await open(delayed.p);
	const started = delayed.p.waitForRequest('**/drafts/__data.json*');
	const navigation = delayed.p.getByRole('link', { name: '초안 검토', exact: true }).click();
	try {
		await started;
		await opened(delayed.p, true);
		await shot(delayed.p, 'pending-navigation');
	} finally {
		release();
	}
	await navigation;
	await delayed.p.waitForURL(base + '/drafts');
	await opened(delayed.p, false);
	await delayed.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		await open(delayed.p);
		await delayed.p.getByRole('link', { name: '자동 연결', exact: true }).click();
		await delayed.p.waitForURL(base + '/links');
		await opened(delayed.p, false);
		await delayed.p.getByRole('alert').waitFor();
		await shot(delayed.p, 'navigation-error');
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await delayed.c.close();
	reports.push({
		pendingNavigation: 'menu closes only when navigation finishes',
		databaseFailure: 'destination error and menu remain usable'
	});
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
		await open(zoom.p);
		await layout(zoom.p);
		await shot(zoom.p, 'zoom200-' + theme);
		await zoom.c.close();
	}
	const short = await context(360, 'light', { viewport: { width: 360, height: 320 } });
	await short.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
	await open(short.p);
	const last = short.p.getByRole('link', { name: '자동 연결', exact: true });
	await last.focus();
	const rect = await last.boundingBox();
	assert.ok(rect.y + rect.height <= 320);
	await layout(short.p);
	await shot(short.p, 'short-viewport');
	await short.c.close();
	reports.push({ zoomEquivalent: 200, shortViewport: 'menu scrolls inside available height' });
	for (const width of [360, 1440]) {
		const native = await context(width, 'light', { javaScriptEnabled: false });
		await native.p.goto(base + '/wiki/navigation-check');
		await open(native.p);
		await native.p.getByRole('link', { name: 'AI 위키파이어', exact: true }).click();
		await native.p.waitForURL(base + '/wikify');
		await native.p
			.getByRole('heading', { name: '백지에서 시작하지 마세요.', exact: true })
			.waitFor();
		await native.c.close();
	}
	reports.push({ noJavaScript: 'native menu and file conversion link work' });
	const blocked = await context(360, 'light');
	await blocked.c.addInitScript(() => {
		Storage.prototype.getItem = () => {
			throw new Error('Storage unavailable');
		};
		Storage.prototype.setItem = () => {
			throw new Error('Storage unavailable');
		};
	});
	await blocked.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
	await open(blocked.p);
	await blocked.p.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
	await opened(blocked.p, false);
	assert.equal(await blocked.p.locator('html').getAttribute('data-theme'), 'dark');
	await blocked.c.close();
	reports.push({ storageBlocked: 'theme and menu remain usable' });
	assert.deepEqual(await snapshot(), before);
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, unchangedDatabase: true, output };
	await writeFile(output + '/navigation-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
