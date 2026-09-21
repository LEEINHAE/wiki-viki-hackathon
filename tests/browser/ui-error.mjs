import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.UI_ERROR_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-ui-error-')));
const base = 'http://127.0.0.1:4188',
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
	server: { host: '127.0.0.1', port: 4188, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-ui-error-browser',
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
	await sql`INSERT INTO documents(title,slug,content) VALUES('오류 복구 확인','recovery-page','가상 교육 문서입니다.') RETURNING *`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('recovery-alias','복구 별칭',${doc.id})`;
await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${doc.id},'가상 토론','보존할 의견','Editor-02')`;
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object(
 'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
 'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
 'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
 'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) data`
	)[0].data;
const before = await snapshot();
async function context(width, theme, options = {}) {
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
	p.on('pageerror', (e) => errors.push(e.message));
	return { c, p };
}
async function inspect(p, status, title) {
	await p.getByRole('heading', { name: title, exact: true }).waitFor();
	assert.equal(await p.locator('main .eyebrow').innerText(), '오류 ' + status);
	assert.equal(await p.getByRole('alert').count(), 1);
	assert.equal(
		await p.getByRole('link', { name: '홈으로', exact: true }).getAttribute('href'),
		'/'
	);
	const retry = p.getByRole('link', { name: '다시 불러오기', exact: true });
	assert.equal(await retry.getAttribute('data-sveltekit-reload'), '');
	assert.equal(
		await retry.getAttribute('href'),
		new URL(p.url()).pathname + new URL(p.url()).search + new URL(p.url()).hash
	);
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
	const h = await p.locator('main h1').evaluate((e) => ({
		font: getComputedStyle(e).fontFamily,
		weight: getComputedStyle(e).fontWeight
	}));
	assert.match(h.font, /Figtree/);
	assert.equal(h.weight, '700');
}
async function recover(p) {
	const retry = p.getByRole('link', { name: '다시 불러오기', exact: true });
	const navigated = p.waitForResponse(
		(r) =>
			r.request().isNavigationRequest() &&
			r.url().includes('/wiki/recovery-page') &&
			r.status() === 200
	);
	await retry.focus();
	await p.keyboard.press('Enter');
	await navigated;
	await p.getByRole('heading', { name: doc.title, exact: true }).waitFor();
	assert.equal(new URL(p.url()).search, '?source=ui-check');
	assert.equal(await p.getByRole('link', { name: '다시 불러오기', exact: true }).count(), 0);
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			const notFound = await p.goto(base + '/missing-route?source=ui-check', {
				waitUntil: 'networkidle'
			});
			assert.equal(notFound.status(), 404);
			await inspect(p, 404, '페이지를 찾을 수 없습니다.');
			await p.screenshot({ path: output + `/404-${width}-${theme}.png`, fullPage: true });
			await p.getByRole('link', { name: '홈으로', exact: true }).focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(base + '/');
			await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
			try {
				const response = await p.goto(base + '/wiki/recovery-page?source=ui-check', {
					waitUntil: 'networkidle'
				});
				assert.equal(response.status(), 503);
				await inspect(p, 503, '페이지를 불러오지 못했습니다.');
				await p
					.getByText('문서를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.', { exact: true })
					.waitFor();
				assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
				await p.screenshot({ path: output + `/503-${width}-${theme}.png`, fullPage: true });
			} finally {
				await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
			}
			await recover(p);
			await c.close();
			reports.push({
				width,
				theme,
				notFound: 404,
				loadFailure: 503,
				nativeRetry: true,
				queryPreserved: true
			});
		}
	const { c, p } = await context(360, 'light', { javaScriptEnabled: false });
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		const r = await p.goto(base + '/wiki/recovery-page?source=ui-check');
		assert.equal(r.status(), 503);
		await inspect(p, 503, '페이지를 불러오지 못했습니다.');
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await recover(p);
	await c.close();
	reports.push({ noJavaScript: 'SSR error and native retry recover' });
	const unexpected = await context(768, 'dark');
	await sql`ALTER TABLE discussions RENAME TO discussions_unavailable`;
	try {
		const r = await unexpected.p.goto(base + '/wiki/recovery-page?source=ui-check', {
			waitUntil: 'networkidle'
		});
		assert.equal(r.status(), 500);
		await inspect(unexpected.p, 500, '페이지를 불러오지 못했습니다.');
		assert.doesNotMatch(
			await unexpected.p.locator('main').innerText(),
			/PostgresError|SELECT|discussions_unavailable/
		);
		await unexpected.p.screenshot({ path: output + '/500-768-dark.png', fullPage: true });
	} finally {
		await sql`ALTER TABLE discussions_unavailable RENAME TO discussions`;
	}
	await recover(unexpected.p);
	await unexpected.c.close();
	reports.push({ unexpectedFailure: 500, sanitized: true, retry: true });
	assert.deepEqual(await snapshot(), before);
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, unchangedDatabase: true, output };
	await writeFile(output + '/ui-error-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
