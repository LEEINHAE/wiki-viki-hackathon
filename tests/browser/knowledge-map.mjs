import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { mapDocuments, mapAliases } from '../fixtures/knowledge-map.js';
import { documentHref, knowledgeMapHref } from '../../src/lib/knowledge.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.MAP_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-map-')));
await mkdir(output, { recursive: true });
const base = 'http://127.0.0.1:4194',
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
	cacheDir: output + '/cache',
	resolve: { alias: { '$env/dynamic/private': fixture } },
	server: { host: '127.0.0.1', port: 4194, strictPort: true, watch: null },
	plugins: [
		{
			name: 'map-browser',
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
const sql = state.db();
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = [],
	errors = [];
async function seed() {
	for (const d of mapDocuments)
		await sql`INSERT INTO documents(id,slug,title,content) VALUES(${d.id},${d.slug},${d.title},${d.content})`;
	for (const a of mapAliases)
		await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${a.alias_slug},${a.alias_title},${a.document_id})`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(1,'원래 본문','Editor-01')`;
	await sql`INSERT INTO drafts(title,slug,content) VALUES('보존 초안','draft','보존 본문')`;
}
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object(
	'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
	'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
	'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
	'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
	)[0].data;
async function context(width, theme, options = {}) {
	const c = await browser.newContext({
		viewport: { width, height: 950 },
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
async function center(p, slug) {
	await p.waitForFunction(
		(href) => document.querySelector('.map-center')?.getAttribute('href') === href,
		documentHref(slug)
	);
}
const neighbor = (p, title) =>
	p.getByRole('link', { name: `${title} 중심으로 연결 보기`, exact: true });
async function shot(p, name) {
	await p.locator('.map-panel').screenshot({ path: `${output}/${name}.png` });
}
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
try {
	await seed();
	const before = await snapshot();
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + knowledgeMapHref(), { waitUntil: 'networkidle' });
			await center(p, 'root');
			assert.equal(await p.locator('.map-node').count(), 7);
			assert.equal(await p.locator('.knowledge-map a[href^="/wiki/"]').count(), 1);
			await shot(p, `initial-${width}-${theme}`);
			await neighbor(p, '나뭇가지 지식').focus();
			await p.keyboard.press('Enter');
			await center(p, 'branch');
			assert.equal(new URL(p.url()).searchParams.get('center'), 'branch');
			assert.equal(
				await p.evaluate(() => document.activeElement?.classList.contains('map-center')),
				true
			);
			assert.equal(await p.locator('.map-node').count(), 3);
			await neighbor(p, '깊은 지식').click();
			await center(p, 'deep');
			assert.equal(await neighbor(p, '끝 지식').count(), 1);
			await shot(p, `recentered-${width}-${theme}`);
			await p.goBack();
			await center(p, 'branch');
			await p.goForward();
			await center(p, 'deep');
			await p.reload();
			await center(p, 'deep');
			await p.locator('.map-center').focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(base + '/wiki/deep');
			await p.getByRole('heading', { name: '깊은 지식', exact: true }).waitFor();
			await p.goBack();
			await center(p, 'deep');
			await p.goto(base + knowledgeMapHref('root'), { waitUntil: 'networkidle' });
			await p.getByRole('link', { name: '다음 연결 →', exact: true }).click();
			await p.waitForURL(/mapPage=2/);
			await center(p, 'root');
			assert.equal(await p.locator('.map-node').count(), 3);
			const list = p.getByRole('navigation', { name: '지도에 표시된 연결 문서' });
			const next = new URL(
				await list.getByRole('link').first().getAttribute('href'),
				base
			).searchParams.get('center');
			await list.getByRole('link').first().click();
			await center(p, next);
			assert.equal(new URL(p.url()).searchParams.has('mapPage'), false);
			await p.getByLabel('중심 문서', { exact: true }).selectOption('standalone');
			await p.getByRole('button', { name: '연결 보기', exact: true }).click();
			await center(p, 'standalone');
			assert.equal(await p.locator('.map-node').count(), 1);
			await p.getByText('이 문서와 연결된 다른 문서는 없습니다.', { exact: false }).waitFor();
			await noOverflow(p);
			await shot(p, `isolated-${width}-${theme}`);
			reports.push({
				width,
				theme,
				chain: 'root→branch→deep',
				centerOpensDocument: true,
				history: true,
				allNeighbors: true,
				isolated: true,
				keyboard: true
			});
			await c.close();
		}
	assert.deepEqual(await snapshot(), before);
	const { c, p } = await context(360, 'light');
	await p.goto(base + knowledgeMapHref('root'), { waitUntil: 'networkidle' });
	const held = Promise.withResolvers(),
		release = Promise.withResolvers();
	await p.route(
		(u) => u.pathname === '/__data.json' && u.searchParams.get('center') === 'branch',
		async (route) => {
			held.resolve();
			await release.promise;
			await route.continue();
		},
		{ times: 1 }
	);
	const moving = neighbor(p, '나뭇가지 지식').click();
	try {
		await held.promise;
		await p.getByRole('status').filter({ hasText: '연결된 문서를 불러오고 있습니다.' }).waitFor();
		assert.equal(await p.locator('.knowledge-map').getAttribute('aria-busy'), 'true');
		await shot(p, 'loading');
	} finally {
		release.resolve();
	}
	await moving;
	await center(p, 'branch');
	await sql`ALTER TABLE documents RENAME TO map_unavailable`;
	try {
		await neighbor(p, '깊은 지식').click();
		await p
			.getByRole('heading', { name: '문서 연결을 불러오지 못했습니다.', exact: true })
			.waitFor();
		assert.equal(await p.locator('.knowledge-map').count(), 0);
		assert.equal(new URL(p.url()).searchParams.get('center'), 'deep');
		await p.screenshot({ path: output + '/error.png', fullPage: true });
	} finally {
		await sql`ALTER TABLE map_unavailable RENAME TO documents`;
	}
	await p.getByRole('link', { name: '다시 불러오기', exact: true }).click();
	await center(p, 'deep');
	await sql`UPDATE documents SET deleted_at=now(),deleted_by='Editor-01' WHERE slug='deep'`;
	await p.reload();
	await center(p, 'root');
	await p.getByText('선택한 문서를 찾을 수 없습니다.', { exact: false }).waitFor();
	assert.equal(await p.locator('option[value="deep"]').count(), 0);
	await shot(p, 'deleted-center');
	await sql`UPDATE documents SET deleted_at=NULL,deleted_by=NULL WHERE slug='deep'`;
	const longTitle = '긴 문서 이름과 & 기호가 포함된 지식을 연결해서 확인하기 '.repeat(8);
	await sql`UPDATE documents SET title=${longTitle} WHERE slug='leaf-1'`;
	await p.goto(base + knowledgeMapHref('root'), { waitUntil: 'networkidle' });
	await noOverflow(p);
	await shot(p, 'long-titles');
	await p.goto(base + knowledgeMapHref('old-name'), { waitUntil: 'networkidle' });
	await center(p, 'deep');
	reports.push({
		loading: true,
		databaseFailureAndRetry: true,
		deletedCenter: true,
		longTitles: true,
		alias: true
	});
	await c.close();
	const basic = await context(768, 'light', { javaScriptEnabled: false });
	await basic.p.goto(base + knowledgeMapHref('root'));
	await neighbor(basic.p, '나뭇가지 지식').click();
	assert.equal(await basic.p.locator('.map-center').getAttribute('href'), '/wiki/branch');
	await neighbor(basic.p, '깊은 지식').click();
	assert.equal(await basic.p.locator('.map-center').getAttribute('href'), '/wiki/deep');
	await basic.p.locator('.map-center').click();
	await basic.p.waitForURL(base + '/wiki/deep');
	await basic.c.close();
	reports.push({ noJavaScript: 'neighbors explore; center opens document' });
	await state.clearDatabase();
	const empty = await context(1440, 'dark');
	await empty.p.goto(base + knowledgeMapHref(), { waitUntil: 'networkidle' });
	assert.equal(await empty.p.locator('.map-node').count(), 0);
	await empty.p
		.getByText('문서를 작성하고 [[위키 링크]]로 연결하면 여기에 지식 지도가 나타납니다.', {
			exact: true
		})
		.waitFor();
	await shot(empty.p, 'empty');
	await empty.c.close();
	reports.push({ empty: true });
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, output };
	await writeFile(output + '/results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
