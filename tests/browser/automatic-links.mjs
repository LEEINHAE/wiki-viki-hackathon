import { openMainMenu } from './helpers/navigation.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = dirname(fileURLToPath(import.meta.url)),
	output =
		process.env.LINK_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-auto-links-')));
const project = resolve(root, '../..'),
	fixture = project + '/tests/fixtures/governance-database.js';
const base = 'http://127.0.0.1:4194';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const actualFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (!url.startsWith(base + '/')) {
		externalAttempts++;
		throw new Error('External requests disabled');
	}
	return actualFetch(...args);
};
const server = await createServer({
	root: project,
	configFile: project + '/vite.config.js',
	envDir: false,
	cacheDir: output + '/cache',
	resolve: { alias: { '$env/dynamic/private': fixture } },
	server: { host: '127.0.0.1', port: 4194, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-auto-links-browser',
			enforce: 'pre',
			resolveId(id) {
				if (
					id === project + '/src/lib/server/db.js' ||
					id === '$lib/server/db.js' ||
					id === './db.js'
				)
					return fixture;
			}
		}
	]
});
const state = await server.ssrLoadModule(fixture);
await state.setupDatabase({ maxConnections: 4 });
state.env.OPENAI_API_KEY = '';
const sql = state.db();
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pageErrors = [],
	outbound = [],
	reports = [];
async function seed() {
	await state.clearDatabase();
	const [source] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('교대 인계','handover','## 인계 방법\n\nRFCC와 설비 점검을 확인합니다. 신규 장비를 기록합니다. RFCC를 다시 확인합니다.\n\n코드 예시: \`RFCC\`\n\n[[미작성 문서|예정 문서]]') RETURNING *`;
	const [target] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('RFCC','rfcc','교대 인계에 기록합니다.') RETURNING *`;
	const [equipment] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('정기 점검','inspection','점검 안내') RETURNING *`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('설비-점검','설비 점검',${equipment.id})`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${source.id},${source.content},'Editor-01','기존 본문')`;
	return { source, target, equipment };
}
async function observed(context) {
	await context.route('**/*', async (route) => {
		if (
			!route
				.request()
				.url()
				.startsWith(base + '/')
		) {
			outbound.push(route.request().url());
			return route.abort();
		}
		return route.continue();
	});
	const p = await context.newPage();
	p.on('pageerror', (error) => pageErrors.push(error.message));
	return p;
}
async function shot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { source } = await seed();
			const context = await browser.newContext({
				viewport: { width, height: 950 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			const p = await observed(context);
			await p.goto(base + '/wiki/handover', { waitUntil: 'networkidle' });
			assert.equal(await p.locator('.wiki-content [data-auto-link]').count(), 2);
			assert.equal(await p.locator('.wiki-content code a').count(), 0);
			assert.equal(await p.locator('.wiki-content a a').count(), 0);
			assert.equal(
				await p
					.locator('.wiki-content')
					.getByRole('link', { name: '설비 점검', exact: true })
					.getAttribute('href'),
				'/wiki/inspection'
			);
			await shot(p, `reading-${width}-${theme}`);
			await p.locator('.wiki-content').getByRole('link', { name: 'RFCC', exact: true }).focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(base + '/wiki/rfcc');
			await p
				.locator('.backlinks')
				.getByRole('link', { name: '교대 인계 ↗', exact: true })
				.waitFor();
			await openMainMenu(p);
			await p
				.getByRole('navigation', { name: '주요 메뉴' })
				.getByRole('link', { name: '자동 연결', exact: true })
				.click();
			await p.waitForURL(base + '/links');
			const stats = p.getByRole('definition');
			assert.deepEqual(await stats.allTextContents(), ['3', '3', '3', '0']);
			const button = p.getByRole('button', { name: '전체 검사·자동 재연결', exact: true });
			await shot(p, `inspection-${width}-${theme}`);
			let release;
			const gate = new Promise((resolve) => (release = resolve));
			await p.route(
				'**/links/__data.json*',
				async (route) => {
					await gate;
					await route.continue();
				},
				{ times: 1 }
			);
			await button.focus();
			await p.keyboard.press('Enter');
			await p.getByRole('button', { name: '전체 연결 검사 중…', exact: true }).waitFor();
			assert.equal(
				await p.getByRole('button', { name: '전체 연결 검사 중…', exact: true }).isDisabled(),
				true
			);
			await shot(p, `loading-${width}-${theme}`);
			await sql`INSERT INTO documents(title,slug,content) VALUES('신규 장비','new-equipment','교대 인계에 기록합니다.')`;
			release();
			await p
				.getByRole('status')
				.filter({ hasText: '최신 문서와 별칭으로 전체 연결을 다시 계산했습니다.' })
				.waitFor();
			assert.deepEqual(await stats.allTextContents(), ['4', '5', '5', '0']);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${source.id}`)[0].content,
				source.content
			);
			assert.equal(
				(await sql`SELECT count(*)::int n FROM revisions WHERE document_id=${source.id}`)[0].n,
				1
			);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await p.goto(base + '/wiki/handover', { waitUntil: 'networkidle' });
			assert.equal(await p.locator('.wiki-content [data-auto-link]').count(), 3);
			await p.goto(base + '/links', { waitUntil: 'networkidle' });
			await sql`ALTER TABLE redirects RENAME TO automatic_unavailable_aliases`;
			try {
				await button.click();
				await p
					.getByRole('alert')
					.filter({ hasText: '문서 연결을 불러오지 못했습니다.' })
					.waitFor();
				assert.equal(await stats.count(), 0);
				await shot(p, `error-${width}-${theme}`);
			} finally {
				await sql`ALTER TABLE automatic_unavailable_aliases RENAME TO redirects`;
			}
			await button.click();
			await p.getByRole('definition').first().waitFor();
			await state.clearDatabase();
			await button.click();
			await p.getByRole('heading', { name: '아직 게시된 문서가 없습니다.', exact: true }).waitFor();
			await shot(p, `empty-${width}-${theme}`);
			reports.push({
				width,
				theme,
				links: true,
				backlinks: true,
				reconnect: true,
				errorAndEmpty: true,
				noSourceWrites: true
			});
			await context.close();
		}
	await state.clearDatabase();
	await sql`INSERT INTO documents(title,slug,content) SELECT '문서 '||n,'document-'||n,'' FROM generate_series(1,23) n`;
	const context = await browser.newContext({
		viewport: { width: 360, height: 950 },
		javaScriptEnabled: false
	});
	const p = await observed(context);
	await p.goto(base + '/links', { waitUntil: 'networkidle' });
	assert.equal(await p.locator('.connection-list > li').count(), 20);
	await p.getByRole('link', { name: '다음 →', exact: true }).click();
	assert.equal(await p.locator('.connection-list > li').count(), 3);
	await p.getByRole('button', { name: '전체 검사·자동 재연결', exact: true }).click();
	assert.equal(await p.locator('.connection-list > li').count(), 20);
	reports.push({ noJavaScript: true, pagination: [20, 3], reconnect: true });
	await context.close();
	assert.deepEqual(pageErrors, []);
	assert.deepEqual(outbound, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/automatic-links-results.json',
		JSON.stringify({ reports, pageErrors, outbound, externalAttempts }, null, 2)
	);
	console.log(JSON.stringify({ reports, pageErrors, outbound, externalAttempts, output }, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = actualFetch;
}
