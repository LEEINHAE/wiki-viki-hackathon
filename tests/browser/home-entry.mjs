import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.HOME_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-home-entry-')));
const base = 'http://127.0.0.1:4185',
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
	server: { host: '127.0.0.1', port: 4185, strictPort: true, watch: null },
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

const [tank] =
	await sql`INSERT INTO documents(title,slug,content) VALUES('탱크 점검','tank-check','실제 설비 안내') RETURNING *`;
const [guide] =
	await sql`INSERT INTO documents(title,slug,content) VALUES('교대 인계 가이드','handover-guide','[[tank-check|탱크 점검]]을 확인합니다.') RETURNING *`;
await sql`INSERT INTO documents(title,slug,content) VALUES('RFCC 공정','process','[[handover-guide|교대 인계 가이드]]를 확인합니다.')`;
for (let i = 0; i < 13; i++)
	await sql`INSERT INTO documents(title,slug,content) VALUES(${'교대 인계 상세 ' + i},${'handover-' + i},'별도의 가상 절차 본문')`;
await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('비상 훈련','archived-safety','보관된 본문',NOW(),'Editor-01')`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${guide.id},${guide.content},'Editor-01')`;
await sql`INSERT INTO drafts(title,slug,content,status,governance) VALUES('검토 초안','review-home','가상 초안','review','{"passed":true}'),('확인 초안','blocked-home','확인 대기','blocked','{"passed":false}')`;
await sql`INSERT INTO announcements(title,body) VALUES('가상 공지','공지의 실제 내용')`;
await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${guide.id},'가상 토론','토론의 실제 내용','Editor-02')`;
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),'announcements',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM announcements d)) data`
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

const fields = (p) => p.getByRole('navigation', { name: '문서 분야', exact: true });
const documents = (p) => p.getByRole('region', { name: '분야별 문서 목록', exact: true });
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
async function selectCategory(p, name) {
	await fields(p).getByRole('link', { name, exact: true }).focus();
	await p.keyboard.press('Enter');
	await p.waitForURL((url) => url.hash === '#home-documents');
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + '/', { waitUntil: 'networkidle' });
			await shot(p, 'home-' + width + '-' + theme);
			assert.equal(await fields(p).count(), 1, 'home must provide actual category entry points');
			await p.getByRole('heading', { name: '처음 오셨나요?', exact: true }).waitFor();
			const order = await p.evaluate(() => {
				const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
				return {
					search: rect('#wiki-search').bottom,
					fields: rect('.home-fields').top,
					guide: rect('.home-guide').top,
					stats: rect('.stats-grid').top,
					intro: rect('.home-intro').top
				};
			});
			assert.ok(
				order.search <= order.fields &&
					order.search <= order.guide &&
					order.fields < order.stats &&
					order.guide < order.stats &&
					order.stats < order.intro
			);
			assert.deepEqual(await fields(p).getByRole('link').allTextContents(), [
				'전체 16',
				'공정 1',
				'설비 1',
				'업무 절차 14'
			]);
			assert.equal(await p.locator('.stat-card strong').nth(0).textContent(), '16');
			assert.equal(await p.locator('.stat-card strong').nth(1).textContent(), '1');
			assert.equal(await p.locator('.stat-card strong').nth(2).textContent(), '2');
			assert.equal(await p.locator('.stat-card strong').nth(3).textContent(), '2');
			assert.equal(await documents(p).getByRole('link').count(), 12);
			await noOverflow(p);
			await selectCategory(p, '업무 절차 14');
			await p.getByRole('heading', { name: '업무 절차 문서', exact: true }).waitFor();
			assert.equal(new URL(p.url()).searchParams.get('category'), '업무 절차');
			assert.equal(
				await fields(p)
					.getByRole('link', { name: '업무 절차 14', exact: true })
					.getAttribute('aria-current'),
				'true'
			);
			await p.getByText('14개 중 최근 수정된 12개를 표시합니다.', { exact: true }).waitFor();
			assert.equal(await documents(p).getByRole('link').count(), 12);
			assert.equal(
				await documents(p)
					.getByRole('link', { name: /탱크 점검/ })
					.count(),
				0
			);
			await p.waitForFunction(
				() => document.querySelector('#home-documents').getAttribute('aria-busy') === 'false'
			);
			await p.keyboard.press('Tab');
			assert.equal(
				await documents(p)
					.getByRole('link')
					.first()
					.evaluate((e) => e === document.activeElement),
				true,
				'category navigation continues with the first document by Tab'
			);
			await p.reload({ waitUntil: 'networkidle' });
			await p.getByRole('heading', { name: '업무 절차 문서', exact: true }).waitFor();
			const first = documents(p).getByRole('link').first(),
				href = await first.getAttribute('href');
			await first.focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(base + href);
			await p.goBack({ waitUntil: 'networkidle' });
			assert.equal(new URL(p.url()).searchParams.get('category'), '업무 절차');
			await selectCategory(p, '설비 1');
			await p.getByRole('heading', { name: '설비 문서', exact: true }).waitFor();
			assert.equal(await documents(p).getByRole('link').count(), 1);
			assert.equal(
				await documents(p).getByRole('link').first().getAttribute('href'),
				'/wiki/tank-check'
			);
			await shot(p, 'category-' + width + '-' + theme);
			await noOverflow(p);
			await p.getByRole('combobox', { name: '위키 문서 검색', exact: true }).fill('탱크');
			await p.keyboard.press('Enter');
			await p.waitForURL('**/?q=*');
			await p.getByRole('heading', { name: '「탱크」 검색 결과', exact: true }).waitFor();
			for (const [view, heading] of [
				['activity', '검토를 기다리는 초안'],
				['map', '지식은 연결될수록 커집니다']
			]) {
				await p.goto(base + '/?view=' + view + '#explore', { waitUntil: 'networkidle' });
				await p.getByRole('heading', { name: heading, exact: true }).waitFor();
				await noOverflow(p);
				await shot(p, view + '-' + width + '-' + theme);
			}
			await p.goto(base + '/', { waitUntil: 'networkidle' });
			await p
				.locator('.home-guide')
				.getByRole('link', { name: '기존 자료 올리기', exact: true })
				.focus();
			await p.keyboard.press('Enter');
			await p.getByRole('dialog', { name: 'AI 위키파이어', exact: true }).waitFor();
			await p.keyboard.press('Escape');
			await p.getByRole('dialog').waitFor({ state: 'hidden' });
			await p
				.locator('.home-guide')
				.getByRole('link', { name: '새 문서 작성', exact: true })
				.click();
			await p.waitForURL(base + '/new');
			await c.close();
			reports.push({
				width,
				theme,
				searchFirst: true,
				categories: 'actual counts; latest 12; URL/reload/back',
				views: true,
				modalAndNewEntry: true
			});
		}
	const pending = await context(360, 'light');
	await pending.p.goto(base + '/', { waitUntil: 'networkidle' });
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	await pending.p.route('**/__data.json*', async (route) => {
		await gate;
		await route.continue();
	});
	await fields(pending.p).getByRole('link', { name: '업무 절차 14', exact: true }).focus();
	const started = pending.p.waitForRequest('**/__data.json*');
	const request = pending.p.keyboard.press('Enter');
	try {
		await started;
		await pending.p.getByText('선택한 분야의 문서를 불러오고 있습니다.', { exact: true }).waitFor();
		assert.equal(await documents(pending.p).getAttribute('aria-busy'), 'true');
		assert.equal(await documents(pending.p).getByRole('link').count(), 12);
		await shot(pending.p, 'loading-category');
	} finally {
		release();
	}
	await request;
	await pending.p.getByRole('heading', { name: '업무 절차 문서', exact: true }).waitFor();
	assert.equal(await documents(pending.p).getAttribute('aria-busy'), 'false');
	await pending.c.close();
	reports.push({ loading: 'actual navigation state; previous documents remain visible' });
	const { c, p } = await context(360, 'light');
	await p.goto(
		base + '/?view=search&category=' + encodeURIComponent('사라진 분야') + '#home-documents',
		{ waitUntil: 'networkidle' }
	);
	await p.getByText('이 분야의 게시 문서가 없습니다.', { exact: true }).waitFor();
	await documents(p).getByRole('link', { name: '전체 분야 보기', exact: true }).click();
	await p.waitForURL('**/?view=search#home-documents');
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		await p.reload({ waitUntil: 'networkidle' });
		assert.deepEqual(await p.locator('.stat-card strong').allTextContents(), ['—', '—', '—', '—']);
		await documents(p).getByText('문서 목록을 불러오지 못했습니다.', { exact: true }).waitFor();
		assert.equal(await fields(p).count(), 0);
		await shot(p, 'database-error');
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await documents(p).getByRole('link', { name: '다시 불러오기', exact: true }).click();
	await fields(p).waitFor();
	assert.equal(await documents(p).getByRole('link').count(), 12);
	await c.close();
	reports.push({
		staleCategory: true,
		databaseFailure: 'unknown counts, no fake categories, explicit reload restores documents'
	});
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/', { waitUntil: 'networkidle' });
		await noOverflow(zoom.p);
		await shot(zoom.p, 'zoom200-' + theme);
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200 });
	const native = await context(360, 'light', { javaScriptEnabled: false });
	await native.p.goto(base + '/');
	await selectCategory(native.p, '설비 1');
	await native.p.getByRole('heading', { name: '설비 문서', exact: true }).waitFor();
	await documents(native.p).getByRole('link').click();
	await native.p.waitForURL(base + '/wiki/tank-check');
	await native.c.close();
	reports.push({ noJavaScript: 'native category links and document navigation' });
	assert.deepEqual(await snapshot(), before);
	// Empty state is measured separately from lookup failure.
	await sql`TRUNCATE documents,drafts,announcements RESTART IDENTITY CASCADE`;
	for (const theme of ['light', 'dark']) {
		const empty = await context(360, theme);
		await empty.p.goto(base + '/', { waitUntil: 'networkidle' });
		assert.deepEqual(await empty.p.locator('.stat-card strong').allTextContents(), [
			'0',
			'0',
			'0',
			'0'
		]);
		await empty.p.getByText('아직 게시된 문서가 없습니다.', { exact: true }).waitFor();
		assert.equal(await fields(empty.p).getByRole('link').count(), 1);
		await empty.p
			.locator('.home-guide')
			.getByRole('link', { name: '새 문서 작성', exact: true })
			.waitFor();
		await noOverflow(empty.p);
		await shot(empty.p, 'empty-' + theme);
		await empty.c.close();
	}
	reports.push({
		empty: 'zero counts, honest guidance, create/upload available',
		readOnlyPreservation: true
	});
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, output };
	await writeFile(output + '/home-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
