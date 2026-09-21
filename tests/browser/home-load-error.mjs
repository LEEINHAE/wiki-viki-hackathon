import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.HOME_ERROR_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-home-error-')));
const base = 'http://127.0.0.1:4184',
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
	server: { host: '127.0.0.1', port: 4184, strictPort: true, watch: null },
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
	await sql`INSERT INTO documents(title,slug,content) VALUES('가상 안내','lookup-guide','[[resource|참고 자료]] [[없는 지식]]') RETURNING *`;
await sql`INSERT INTO documents(title,slug,content) VALUES('참고 자료','resource','참고 자료 본문')`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
const [draft] =
	await sql`INSERT INTO drafts(title,slug,content,governance) VALUES('가상 초안','lookup-draft','검토 내용','{"passed":true}') RETURNING *`;
await sql`INSERT INTO announcements(title,body) VALUES('가상 공지','실제 공지 본문')`;
await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${doc.id},'가상 토론','실제 토론 본문','Editor-02')`;
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

const cases = [
	{ name: 'activity', path: '/?view=activity#explore', title: '활동 정보를 불러오지 못했습니다.' },
	{ name: 'map', path: '/?view=map#explore', title: '문서 연결을 불러오지 못했습니다.' },
	{
		name: 'search',
		path:
			'/?q=' +
			encodeURIComponent('가상 안내') +
			'&view=activity&category=' +
			encodeURIComponent('일반 지식') +
			'#results',
		title: '검색 결과를 불러오지 못했습니다.'
	}
];
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
async function failed(p, item) {
	const content = await p.locator('main').innerText();
	for (const falseClaim of [
		'함께 완성할 초안 0건',
		'이어질 지식 0곳',
		'아직 작성된 문서가 없습니다.',
		'아직 연결된 문서가 없습니다.',
		'등록된 공지가 없습니다.',
		'문서 0건',
		'전체 0',
		'아직 기록되지 않은 지식이에요.'
	])
		assert.equal(
			content.includes(falseClaim),
			false,
			'lookup failure must not claim: ' + falseClaim
		);
	await p.getByRole('heading', { name: item.title, exact: true }).waitFor();
	await p.getByRole('alert').waitFor();
	assert.equal(await p.locator('.answer-card, .map-node, .mini-draft, .search-result').count(), 0);
	const retry = p.getByRole('link', { name: '다시 불러오기', exact: true });
	assert.equal(await retry.count(), 1);
	const requested = new URL(base + item.path);
	assert.equal(await retry.getAttribute('href'), requested.pathname + requested.search);
	if (item.name === 'search') {
		await p.getByText('문서 수 확인 불가', { exact: true }).waitFor();
		assert.equal(
			await p.getByRole('combobox', { name: '용어 검색', exact: true }).inputValue(),
			'가상 안내'
		);
	}
	await noOverflow(p);
}
async function normal(p, item) {
	if (item.name === 'activity') {
		await p.getByRole('heading', { name: '검토를 기다리는 초안', exact: true }).waitFor();
		assert.equal(await p.locator('.mini-draft').getAttribute('href'), '/drafts?open=' + draft.id);
		assert.equal(
			await p.locator('.discussion-link').getAttribute('href'),
			'/discussion/lookup-guide'
		);
		await p.getByText('가상 공지', { exact: false }).first().waitFor();
	} else if (item.name === 'map') {
		await p.getByRole('heading', { name: '이어질 지식 1곳', exact: true }).waitFor();
		assert.equal(await p.locator('.map-node').count(), 2);
	} else {
		await p.getByText('문서 1건', { exact: true }).waitFor();
		assert.equal(await p.locator('.search-result').count(), 1);
	}
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark'])
			for (const item of cases) {
				const { c, p } = await context(width, theme);
				await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
				try {
					await p.goto(base + item.path, { waitUntil: 'networkidle' });
					await shot(p, item.name + '-error-' + width + '-' + theme);
					await failed(p, item);
				} finally {
					await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
				}
				const retry = p.getByRole('link', { name: '다시 불러오기', exact: true });
				await retry.focus();
				await p.keyboard.press('Enter');
				await normal(p, item);
				assert.equal(new URL(p.url()).search, new URL(base + item.path).search);
				await noOverflow(p);
				await c.close();
				reports.push({
					width,
					theme,
					view: item.name,
					failure: 'unknown is not empty',
					retry: 'keyboard full request preserves query'
				});
			}
	// One failed panel query must not make the other unavailable collections appear empty.
	const partial = await context(360, 'dark');
	await sql`ALTER TABLE announcements RENAME TO announcements_unavailable`;
	try {
		await partial.p.goto(base + cases[0].path, { waitUntil: 'networkidle' });
		await failed(partial.p, cases[0]);
	} finally {
		await sql`ALTER TABLE announcements_unavailable RENAME TO announcements`;
	}
	await partial.c.close();
	reports.push({ partialDatabaseFailure: 'shared load reports unavailable data' });
	for (const item of cases) {
		const native = await context(360, 'light', { javaScriptEnabled: false });
		await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
		try {
			await native.p.goto(base + item.path);
			await failed(native.p, item);
		} finally {
			await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
		}
		await native.p.getByRole('link', { name: '다시 불러오기', exact: true }).click();
		await normal(native.p, item);
		assert.equal(new URL(native.p.url()).search, new URL(base + item.path).search);
		await native.c.close();
	}
	reports.push({ noJavaScript: 'query input, view and retry preserved' });
	const delayed = await context(360, 'light');
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		await delayed.p.goto(base + cases[0].path, { waitUntil: 'networkidle' });
		await failed(delayed.p, cases[0]);
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	await delayed.p.route('**/?view=activity', async (route) => {
		await gate;
		await route.continue();
	});
	const cdp = await delayed.c.newCDPSession(delayed.p);
	const started = delayed.p.waitForRequest(base + '/?view=activity');
	let timeout;
	try {
		await Promise.all([
			started,
			delayed.p
				.getByRole('link', { name: '다시 불러오기', exact: true })
				.click({ noWaitAfter: true })
		]);
		// DOM helpers wait for a pending full-page navigation. Capture Chrome's
		// compositor directly for visual review before releasing the new response.
		const pending = await Promise.race([
			cdp.send('Page.captureScreenshot', { format: 'png' }),
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error('Pending screenshot timed out')), 5000);
			})
		]);
		await writeFile(output + '/pending-retry.png', Buffer.from(pending.data, 'base64'));
	} finally {
		clearTimeout(timeout);
		release();
	}
	await normal(delayed.p, cases[0]);
	await delayed.c.close();
	reports.push({
		delayedRetry: 'pending screenshot and successful recovery after response release'
	});
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
		try {
			await zoom.p.goto(base + cases[1].path, { waitUntil: 'networkidle' });
			await failed(zoom.p, cases[1]);
			await shot(zoom.p, 'zoom200-' + theme);
		} finally {
			await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
		}
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200 });
	assert.deepEqual(await snapshot(), before);
	await sql`TRUNCATE documents,drafts,announcements RESTART IDENTITY CASCADE`;
	for (const item of cases) {
		const empty = await context(360, 'light');
		await empty.p.goto(base + item.path, { waitUntil: 'networkidle' });
		assert.equal(
			await empty.p.getByRole('link', { name: '다시 불러오기', exact: true }).count(),
			0
		);
		if (item.name === 'activity')
			await empty.p
				.getByText('함께 완성할 초안 0건. 한 문장부터 살펴보세요.', { exact: true })
				.waitFor();
		else if (item.name === 'map')
			await empty.p.getByRole('heading', { name: '이어질 지식 0곳', exact: true }).waitFor();
		else await empty.p.getByText('문서 0건', { exact: true }).waitFor();
		await shot(empty.p, item.name + '-empty');
		await empty.c.close();
	}
	reports.push({ empty: 'real zero counts are distinct from errors', unchangedDatabase: true });
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, output };
	await writeFile(output + '/home-error-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
