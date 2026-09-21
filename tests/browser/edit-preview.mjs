import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { verifyPreviewResizeFocus } from '../fixtures/preview-focus.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.PREVIEW_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-edit-preview-')));
const base = 'http://127.0.0.1:4191',
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
	server: { host: '127.0.0.1', port: 4191, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-preview-browser',
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
const sample =
	'# 점검 안내\n\n[[장비]] [[Equipment|장비 별칭]] [[없는 문서]] [[보관 장비]]\n\n## 점검 단계\n\n1. 첫 단계\n2. 다음 단계\n\n| 장비 이름 | 아주 긴 두 번째 열 | 세 번째 열 | 네 번째 열 |\n|---|---|---|---|\n| 장비 A | 표시를 확인하는 상세 내용 | 정상 | 확인 |\n\n> 기록을 남겨 주세요.\n\n~~취소선~~ **강조** `코드` [참고](https://example.invalid) [^note]\n\n```js\nconst example = "a long line that remains horizontally scrollable within the code block";\n```\n\n[^note]: 검증용 각주';
async function seed() {
	await state.clearDatabase();
	const [doc] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('미리보기 검증','preview-check','저장된 본문') RETURNING *`;
	const [target] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('장비','장비','장비 본문') RETURNING *`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('equipment','Equipment',${target.id})`;
	await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('보관 장비','보관-장비','보관 본문',NOW(),'Editor-01')`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
	return doc;
}
async function context(width = 1440, theme = 'light', options = {}) {
	const c = await browser.newContext({
		viewport: { width, height: 1000 },
		reducedMotion: 'reduce',
		...options
	});
	await c.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
	await c.route('**/*', (route) => {
		if (
			!route
				.request()
				.url()
				.startsWith(base + '/')
		) {
			externalCalls++;
			return route.abort();
		}
		return route.continue();
	});
	const p = await c.newPage();
	p.on('pageerror', (error) => errors.push(error.message));
	p.on('dialog', (dialog) => dialog.dismiss());
	await p.goto(base + '/edit/preview-check', { waitUntil: 'networkidle' });
	return { c, p };
}
const body = (p) => p.getByLabel('위키 본문', { exact: true });
async function view(p, name) {
	await p.locator('.preview-panel').waitFor({ state: 'attached' });
	const tab = p.getByRole('tab', { name, exact: true });
	if (await tab.count()) await tab.click();
}
async function rendered(p, text) {
	await view(p, '미리보기');
	await p
		.locator('.preview-panel .wiki-content')
		.getByText(text, { exact: false })
		.first()
		.waitFor();
}
async function shot(p, name) {
	await p.evaluate(() => {
		window.scrollTo({ top: 0, behavior: 'instant' });
		const textarea = document.querySelector('#content');
		if (textarea) textarea.scrollTop = 0;
	});
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
}
async function submit(p, button) {
	const response = p.waitForResponse(
		(r) => r.url().includes('/edit/') && r.request().method() === 'POST'
	);
	await button.click();
	const r = await response;
	return r.headers()['content-type']?.includes('application/json')
		? (await r.json()).status
		: r.status();
}
try {
	for (const width of [360, 768, 1440, 720])
		for (const theme of ['light', 'dark']) {
			const doc = await seed(),
				{ c, p } = await context(width, theme, { deviceScaleFactor: width === 720 ? 2 : 1 });
			await rendered(p, '저장된 본문');
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			if (width < 1024) {
				const tab = p.getByRole('tab', { name: '미리보기', exact: true });
				await tab.focus();
				await p.keyboard.press('ArrowLeft');
				assert.equal(
					await p.getByRole('tab', { name: '편집', exact: true }).getAttribute('aria-selected'),
					'true'
				);
				assert.equal(await body(p).isVisible(), true);
			}
			await view(p, '편집');
			const version = await p.locator('[name="version"]').inputValue();
			await body(p).fill('');
			await view(p, '미리보기');
			await p.getByText('본문을 입력하면 미리보기가 표시됩니다.', { exact: true }).waitFor();
			await p.getByRole('button', { name: '문서 저장', exact: true }).click();
			await body(p).waitFor();
			assert.equal(await body(p).isVisible(), true);
			await p.getByLabel('문서 제목', { exact: true }).fill('현재 입력 제목');
			await body(p).fill(sample);
			await rendered(p, '점검 안내');
			await p.getByText('미저장 변경 있음 · 현재 입력을 미리 봅니다.', { exact: true }).waitFor();
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
				doc.content
			);
			assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 1);
			const html = await p.locator('.preview-panel .wiki-content').innerHTML();
			assert.ok(html.includes('wiki-link missing'));
			assert.equal(await p.locator('.preview-panel .wiki-content script').count(), 0);
			let writes = 0;
			p.on('request', (request) => {
				if (request.method() === 'POST' && request.url().includes('/edit/')) writes++;
			});
			await p.locator('.preview-panel .toc button').click();
			await p.locator('.preview-panel .toc button').click();
			await p.locator('.preview-panel .toc a[href="#section-2"]').click();
			assert.equal(new URL(p.url()).hash, '#section-2');
			assert.ok(
				await p
					.locator('#section-2')
					.evaluate(
						(el) =>
							el.getBoundingClientRect().top >=
							document.querySelector('.topbar').getBoundingClientRect().bottom
					)
			);
			await p.locator('.preview-panel .footnote-ref a').focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, '#fn-note');
			await p.locator('.preview-panel .footnote-backlink').focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, '#fnref-note-1');
			assert.equal(await p.evaluate(() => document.activeElement.id), 'fnref-note-1');
			await verifyPreviewResizeFocus(p, p.locator('.wiki-editor'));
			assert.equal(writes, 0);
			assert.equal(await p.locator('[name="version"]').inputValue(), version);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `normal-${width}-${theme}`);
			// A failed preview neither saves nor clears input, and retry uses the current input.
			await p.route('**/api/preview', (route) =>
				route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'synthetic outage' })
				})
			);
			await view(p, '편집');
			await body(p).fill(sample + '\n\n미리보기 재시도 본문');
			await view(p, '미리보기');
			await p
				.getByText('미리보기를 불러오지 못했습니다. 입력 내용은 유지됩니다.', { exact: true })
				.waitFor();
			assert.equal(await body(p).inputValue(), sample + '\n\n미리보기 재시도 본문');
			await shot(p, `error-${width}-${theme}`);
			await p.unroute('**/api/preview');
			await p.getByRole('button', { name: '미리보기 다시 시도', exact: true }).click();
			await rendered(p, '미리보기 재시도 본문');
			// A concurrent edit still requires explicit conflict resolution; preview is not approval.
			await sql`UPDATE documents SET content='다른 작성자의 변경',updated_at=NOW() WHERE id=${doc.id}`;
			await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},'다른 작성자의 변경','Editor-02')`;
			assert.equal(await submit(p, p.getByRole('button', { name: '문서 저장', exact: true })), 409);
			await p.getByRole('region', { name: '현재 저장본과 비교' }).waitFor();
			await rendered(p, '미리보기 재시도 본문');
			assert.equal(await body(p).inputValue(), sample + '\n\n미리보기 재시도 본문');
			assert.equal(await p.locator('[name="version"]').inputValue(), version);
			const reviewedHtml = await p.locator('.preview-panel .wiki-content').innerHTML();
			const styles = await p.locator('.preview-panel .wiki-content h1').evaluate((el) => ({
				font: getComputedStyle(el).fontFamily,
				color: getComputedStyle(el).color
			}));
			await p.getByRole('button', { name: '비교 후 내 수정 내용 저장', exact: true }).click();
			await p.waitForURL(/\/wiki\/preview-check/);
			assert.equal(await p.locator('.wiki-content').innerHTML(), reviewedHtml);
			assert.deepEqual(
				await p.locator('.wiki-content h1').evaluate((el) => ({
					font: getComputedStyle(el).fontFamily,
					color: getComputedStyle(el).color
				})),
				styles
			);
			assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 3);
			assert.equal(
				(await sql`SELECT title FROM documents WHERE id=${doc.id}`)[0].title,
				'현재 입력 제목'
			);
			await c.close();
			reports.push({
				width,
				theme,
				zoomEquivalent: width === 720 ? 200 : 100,
				result:
					'empty/normal/error/retry, keyboard tabs/toc and responsive focus, unsaved input, actual DB conflict and explicit save, published HTML/style equality'
			});
		}
	// Delay an old response even when transport cancellation cannot stop it.
	await seed();
	{
		const { c, p } = await context();
		await p.evaluate(() => {
			const original = window.fetch;
			window.fetch = (input, options) =>
				original(
					input,
					String(input) === '/api/preview' ? { ...options, signal: undefined } : options
				);
		});
		let release, started;
		const gate = new Promise((resolve) => (release = resolve)),
			reached = new Promise((resolve) => (started = resolve));
		await p.route('**/api/preview', async (route) => {
			if (route.request().postDataJSON().content.includes('늦은 응답')) {
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			} else await route.continue();
		});
		await body(p).fill('# 늦은 응답');
		await reached;
		await p.getByText('현재 입력을 미리보기로 바꾸고 있습니다…', { exact: true }).waitFor();
		await shot(p, 'loading');
		await body(p).fill('# 최신 입력');
		await rendered(p, '최신 입력');
		release();
		await delay(300);
		assert.match(await p.locator('.preview-panel .wiki-content').innerText(), /최신 입력/);
		assert.doesNotMatch(await p.locator('.preview-panel .wiki-content').innerText(), /늦은 응답/);
		// Same-page anchors work while ordinary navigation still warns about unsaved input.
		const dialog = p.waitForEvent('dialog');
		await p.getByRole('link', { name: '취소', exact: true }).click();
		await dialog;
		assert.match(p.url(), /\/edit\//);
		assert.equal(await body(p).inputValue(), '# 최신 입력');
		await c.close();
		reports.push({
			staleResponse:
				'old response ignored even when abort is ineffective; navigation cancellation retains latest input'
		});
	}
	await seed();
	{
		const { c, p } = await context();
		await body(p).fill(
			'<script>window.previewExecuted=true</script>\n\n<img src="https://example.invalid/tracking" onerror="window.previewExecuted=true">\n\n[실행](javascript:alert%281%29)'
		);
		await rendered(p, '<script>');
		assert.equal(
			await p
				.locator('.preview-panel script, .preview-panel img, .preview-panel [onerror]')
				.count(),
			0
		);
		assert.equal(await p.evaluate(() => window.previewExecuted), undefined);
		assert.equal(await p.locator('.preview-panel a[href^="javascript:"]').count(), 0);
		await c.close();
		reports.push({
			safeRendering:
				'raw scripts/images escaped and unsafe link scheme removed without external requests'
		});
	}
	await seed();
	{
		const { c, p } = await context();
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		await p.route('**/api/preview', async (route) => {
			await gate;
			await route
				.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ html: '<p>늦은 결과</p>', toc: [] })
				})
				.catch(() => {});
		});
		await body(p).fill('응답 대기 중인 입력');
		await p
			.getByText('미리보기를 불러오지 못했습니다. 입력 내용은 유지됩니다.', { exact: true })
			.waitFor({ timeout: 15000 });
		assert.equal(await body(p).inputValue(), '응답 대기 중인 입력');
		release();
		await p.unroute('**/api/preview');
		await p.getByRole('button', { name: '미리보기 다시 시도', exact: true }).click();
		await rendered(p, '응답 대기 중인 입력');
		assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 1);
		await c.close();
		reports.push({
			timeout:
				'10 second request deadline reports error, retains input and permits retry without saving'
		});
	}
	await seed();
	{
		const { c, p } = await context(360);
		await p.goto(base + '/edit/new-preview', { waitUntil: 'networkidle' });
		await p
			.getByText('아직 저장하지 않은 새 문서 · 현재 입력을 미리 봅니다.', { exact: true })
			.waitFor();
		await p.getByLabel('넘겨주기 별칭', { exact: true }).fill('미리보기 별칭');
		await body(p).fill('# 새 문서 내용\n\n[[new-preview]] [[미리보기 별칭]]');
		await rendered(p, '새 문서 내용');
		await p.setViewportSize({ width: 1440, height: 1000 });
		await body(p).waitFor();
		assert.equal(await p.locator('.preview-panel').isVisible(), true);
		await p.setViewportSize({ width: 360, height: 1000 });
		await rendered(p, '새 문서 내용');
		assert.equal(await body(p).inputValue(), '# 새 문서 내용\n\n[[new-preview]] [[미리보기 별칭]]');
		const newHtml = await p.locator('.preview-panel .wiki-content').innerHTML();
		assert.doesNotMatch(newHtml, /wiki-link missing/);
		await p.getByRole('button', { name: '문서 저장', exact: true }).click();
		await p.waitForURL(/\/wiki\/new-preview/);
		assert.match(await p.locator('.wiki-content').innerText(), /새 문서 내용/);
		assert.equal(await p.locator('.wiki-content').innerHTML(), newHtml);
		await c.close();
		reports.push({
			newDocument: 'new unsaved status, responsive switching and native creation flow preserved'
		});
	}

	await seed();
	{
		const { c, p } = await context(360);
		await body(p).fill('password=NotARealSecret42!');
		await rendered(p, 'password=NotARealSecret42!');
		assert.equal(await submit(p, p.getByRole('button', { name: '문서 저장', exact: true })), 400);
		const fix = p.locator('a[href="#content"]');
		await fix.waitFor();
		await fix.click();
		await body(p).waitFor();
		assert.equal(await body(p).isVisible(), true);
		assert.equal(await body(p).evaluate((el) => el === document.activeElement), true);
		assert.equal(await body(p).inputValue(), 'password=NotARealSecret42!');
		assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 1);
		await c.close();
		reports.push({
			protectedInput:
				'preview does not authorize saving; field correction opens and focuses mobile editor while preserving input'
		});
	}

	await seed();
	{
		const { c, p } = await context(360, 'light', { javaScriptEnabled: false });
		assert.equal(await p.locator('.preview-panel').count(), 0);
		assert.match(
			await p.locator('noscript').last().innerText(),
			/실시간 미리보기는 JavaScript가 필요/
		);
		await body(p).fill('# 기본 폼 저장\n\nJavaScript 없는 입력');
		await p.getByRole('button', { name: '문서 저장', exact: true }).click();
		await p.waitForURL(/\/wiki\/preview-check/);
		assert.match(await p.locator('.wiki-content').innerText(), /JavaScript 없는 입력/);
		await c.close();
		reports.push({ noJavaScript: 'native form saves and published page renders' });
	}
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	await writeFile(
		output + '/preview-browser-results.json',
		JSON.stringify({ reports, errors, externalCalls }, null, 2)
	);
	console.log(JSON.stringify({ reports, errors, externalCalls, output }, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
