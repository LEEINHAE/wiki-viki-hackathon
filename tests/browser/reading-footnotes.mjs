import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.FOOTNOTE_BROWSER_OUTPUT ||
	(await mkdtemp(resolve(tmpdir(), 'wiki-reading-footnotes-')));
const base = 'http://127.0.0.1:4182',
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
	server: { host: '127.0.0.1', port: 4182, strictPort: true, watch: null },
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

const paragraphs = Array.from(
	{ length: 8 },
	() =>
		'가상 점검 자료입니다. 원문의 위치를 잃지 않고 근거와 내용을 대조합니다. 두 번째 참조에서도 같은 각주를 확인하고 돌아올 수 있습니다.'
).join('\n\n');
const content =
	'## 첫 확인\n\n처음 인용[^note]\n\n' +
	paragraphs +
	'\n\n## 두 번째 확인\n\n다시 인용[^note]와 다른 근거[^한글]\n\n' +
	paragraphs +
	'\n\n## 마지막 확인\n\n코드 `[^note]`와 없는 표기[^missing].\n\n[^note]: 실제로 참조한 가상 점검 기준\n[^한글]: 별도의 한글 근거\n[^unused]: 참조하지 않은 설명';
const [doc] =
	await sql`INSERT INTO documents(title,slug,content) VALUES('각주 복귀','footnote-check',${content}) RETURNING *`;
await sql`INSERT INTO documents(title,slug,content) VALUES('각주 없는 문서','no-footnotes','본문만 있는 문서입니다.')`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${content},'Editor-01')`;
const drafts = [];
for (let index = 1; index <= 2; index++) {
	const [draft] =
		await sql`INSERT INTO drafts(title,slug,content,governance) VALUES(${`각주 초안 ${index}`},${`footnote-draft-${index}`},${content},'{"passed":true}') RETURNING id`;
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

async function aligned(p, id) {
	await p.waitForFunction(
		(id) => {
			const r = document.getElementById(id).getBoundingClientRect();
			const header = document.querySelector('.topbar').getBoundingClientRect().bottom;
			const toc = document.querySelector('.article-mobile-toc summary')?.getBoundingClientRect();
			return r.top >= Math.max(header, toc?.height ? toc.bottom : 0) && r.bottom < innerHeight;
		},
		id,
		{ timeout: 5000 }
	);
}
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
async function roundTrip(p) {
	assert.equal(await p.locator('.footnote-ref a').count(), 3);
	assert.equal(await p.locator('.footnote-backlink').count(), 3);
	const ids = await p.locator('[id]').evaluateAll((nodes) => nodes.map((n) => n.id));
	assert.equal(ids.length, new Set(ids).size);
	await p.locator('#fnref-note-1').focus();
	await p.keyboard.press('Enter');
	await p.waitForURL('**#fn-note');
	assert.equal(await p.evaluate(() => document.activeElement.id), 'fn-note');
	await aligned(p, 'fn-note');
	await p.keyboard.press('Tab');
	assert.equal(
		await p.evaluate(() => document.activeElement.getAttribute('href')),
		'#fnref-note-1'
	);
	await p.keyboard.press('Tab');
	assert.equal(
		await p.evaluate(() => document.activeElement.getAttribute('href')),
		'#fnref-note-2'
	);
	await p.keyboard.press('Enter');
	await p.waitForURL('**#fnref-note-2');
	assert.equal(await p.evaluate(() => document.activeElement.id), 'fnref-note-2');
	await aligned(p, 'fnref-note-2');
	await p.keyboard.press('Enter');
	await p.waitForURL('**#fn-note');
	await p.keyboard.press('Tab');
	await p.keyboard.press('Enter');
	await p.waitForURL('**#fnref-note-1');
	assert.equal(await p.evaluate(() => document.activeElement.id), 'fnref-note-1');
	await aligned(p, 'fnref-note-1');
	assert.equal(await p.locator('#fn-unused .footnote-backlink').count(), 0);
	await noOverflow(p);
}
async function draftList(p) {
	await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
	const expand = p.getByRole('button', { name: /^본문 전체 보기/ });
	const count = await expand.count();
	for (let index = 0; index < count; index++) await expand.first().click();
	const ids = await p.locator('[id]').evaluateAll((nodes) => nodes.map((n) => n.id));
	assert.equal(ids.length, new Set(ids).size);
	for (const draft of drafts) {
		const prefix = `draft-${draft.id}-`;
		await p.locator(`[id="${prefix}fnref-note-2"]`).focus();
		await p.keyboard.press('Enter');
		assert.equal(await p.evaluate(() => document.activeElement.id), prefix + 'fn-note');
		await p.locator(`[id="${prefix}fn-note"] .footnote-backlink`).nth(1).focus();
		await p.keyboard.press('Enter');
		assert.equal(await p.evaluate(() => document.activeElement.id), prefix + 'fnref-note-2');
		await p.waitForFunction((id) => {
			const r = document.getElementById(id).getBoundingClientRect();
			return (
				r.top >= document.querySelector('.review-toolbar').getBoundingClientRect().bottom &&
				r.bottom < innerHeight
			);
		}, prefix + 'fnref-note-2');
	}
	await noOverflow(p);
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + '/wiki/footnote-check', { waitUntil: 'networkidle' });
			await roundTrip(p);
			await shot(p, 'return-' + width + '-' + theme);
			await p.goto(base + '/wiki/footnote-check#fn-note', { waitUntil: 'networkidle' });
			await aligned(p, 'fn-note');
			await shot(p, 'notes-' + width + '-' + theme);
			await p.locator('#fn-note .footnote-backlink').nth(1).click();
			await aligned(p, 'fnref-note-2');
			await p.goto(base + '/wiki/footnote-check#fnref-' + encodeURIComponent('한글') + '-1', {
				waitUntil: 'networkidle'
			});
			await aligned(p, 'fnref-한글-1');
			await p.locator('[id="fnref-한글-1"]').click();
			await aligned(p, 'fn-한글');
			await p.locator('[id="fn-한글"] .footnote-backlink').click();
			await aligned(p, 'fnref-한글-1');
			await draftList(p);
			await shot(p, 'draft-return-' + width + '-' + theme);
			await c.close();
			reports.push({
				width,
				theme,
				repeatedReferences: 'each actual location and focus',
				directLinks: 'legacy note plus Korean return target',
				draftList: 'independent prefixes and focus below sticky toolbar'
			});
		}
	for (const width of [360, 1440]) {
		const native = await context(width, 'light', { javaScriptEnabled: false });
		await native.p.goto(base + '/wiki/footnote-check');
		await roundTrip(native.p);
		await draftList(native.p);
		await native.c.close();
	}
	reports.push({ noJavaScript: 'native forward/back links and keyboard focus' });
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/wiki/footnote-check', { waitUntil: 'networkidle' });
		await roundTrip(zoom.p);
		await shot(zoom.p, 'zoom200-' + theme);
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200 });
	const empty = await context(360, 'light');
	await empty.p.goto(base + '/wiki/no-footnotes', { waitUntil: 'networkidle' });
	assert.equal(await empty.p.locator('.footnotes,.footnote-ref').count(), 0);
	await empty.c.close();
	reports.push({ empty: 'no invented footnote section' });
	const failure = await context(360, 'dark');
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		const response = await failure.p.goto(base + '/wiki/footnote-check', {
			waitUntil: 'networkidle'
		});
		assert.equal(response.status(), 503);
		assert.equal(await failure.p.locator('.footnotes').count(), 0);
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await failure.p.getByRole('link', { name: '다시 불러오기', exact: true }).click();
	await failure.p.locator('#fnref-note-1').waitFor();
	await roundTrip(failure.p);
	await failure.c.close();
	reports.push({ databaseFailure: 'actual lookup failure and explicit retry' });
	assert.deepEqual(await snapshot(), before);
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, unchangedDatabase: true, output };
	await writeFile(output + '/footnote-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
