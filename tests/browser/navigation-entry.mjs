import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.ENTRY_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-navigation-entry-')));
const base = 'http://127.0.0.1:4186',
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
	server: { host: '127.0.0.1', port: 4186, strictPort: true, watch: null },
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

const [legacy] =
	await sql`INSERT INTO documents(title,slug,content) VALUES('기존 제목','legacy-address','보존할 기존 본문') RETURNING *`;
await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('별칭-주소','다른 이름',${legacy.id})`;
const [archived] =
	await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('보관 문서','archived-address','보관 본문',NOW(),'Editor-01') RETURNING *`;
await sql`UPDATE documents SET content=${'## 인계 안내\n\n' + Array.from({ length: 70 }, (_, i) => '점검 설명 ' + i + '입니다. 긴 문서의 스크롤 위치를 확인합니다.').join('\n\n') + '\n\n## 마지막 점검\n\n마지막 내용입니다.'} WHERE id=${doc.id}`;
const before = await snapshot();
const names = [
	'검색',
	'문서 탐색',
	'최근 변경',
	'초안 검토',
	'새 문서 작성',
	'AI 위키파이어',
	'휴지통',
	'자동 연결'
];
async function mainMenu(p) {
	await open(p);
	return p.getByRole('navigation', { name: '주요 메뉴', exact: true });
}
async function titleSubmit(p, title) {
	await p.getByLabel('새 문서 제목', { exact: true }).fill(title);
	await p.getByRole('button', { name: '작성 시작', exact: true }).click();
}
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			for (const path of [
				'/',
				'/?q=메뉴',
				'/wiki/navigation-check',
				'/edit/navigation-check',
				'/drafts',
				'/discussion/navigation-check',
				'/history/navigation-check'
			]) {
				await p.goto(base + path, { waitUntil: 'networkidle' });
				const nav = await mainMenu(p);
				assert.deepEqual(await nav.getByRole('link').allTextContents(), names);
				assert.equal(
					await nav.getByRole('link', { name: '새 문서 작성', exact: true }).getAttribute('href'),
					'/new'
				);
				await noOverflow(p);
			}
			const nav = await mainMenu(p);
			await nav.getByRole('link', { name: '문서 탐색', exact: true }).click();
			await p.waitForURL('**/?view=map#explore');
			assert.equal(
				await (
					await mainMenu(p)
				)
					.getByRole('link', { name: '문서 탐색', exact: true })
					.getAttribute('aria-current'),
				'page'
			);
			await (await mainMenu(p)).getByRole('link', { name: '검색', exact: true }).click();
			await p.waitForURL('**/?view=search#wiki-search');
			await p.getByRole('combobox', { name: '위키 문서 검색', exact: true }).waitFor();
			assert.equal(
				await (
					await mainMenu(p)
				)
					.getByRole('link', { name: '검색', exact: true })
					.getAttribute('aria-current'),
				'page'
			);
			await (await mainMenu(p)).getByRole('link', { name: '새 문서 작성', exact: true }).click();
			await p.waitForURL(base + '/new');
			await p.getByRole('heading', { name: '새 문서 작성', exact: true }).waitFor();
			await shot(p, 'new-' + width + '-' + theme);
			await noOverflow(p);
			await p.getByRole('button', { name: '작성 시작', exact: true }).click();
			assert.equal(
				await p
					.getByLabel('새 문서 제목', { exact: true })
					.evaluate((e) => e.validity.valueMissing),
				true
			);
			const title = 'RFCC 50% / A-B & 점검 #' + width;
			await titleSubmit(p, title);
			await p.waitForURL('**/edit/**');
			assert.equal(await p.getByLabel('문서 제목', { exact: true }).inputValue(), title);
			assert.equal(await p.locator('[name="documentId"]').inputValue(), '');
			assert.equal(await p.locator('[name="version"]').inputValue(), 'new');
			await p.getByLabel('위키 본문', { exact: true }).fill('새 문서 진입 후 작성한 미저장 내용');
			const cancel = p.waitForEvent('dialog').then((d) => d.dismiss());
			await (await mainMenu(p)).getByRole('link', { name: '새 문서 작성', exact: true }).click();
			await cancel;
			assert.equal(
				await p.getByLabel('위키 본문', { exact: true }).inputValue(),
				'새 문서 진입 후 작성한 미저장 내용'
			);
			const leave = p.waitForEvent('dialog').then((d) => d.accept());
			await (await mainMenu(p)).getByRole('link', { name: '새 문서 작성', exact: true }).click();
			await leave;
			await p.waitForURL(base + '/new');
			await c.close();
			reports.push({
				width,
				theme,
				mainPages: 7,
				navigation: true,
				titlePreserved: true,
				dirtyCancellation: true
			});
		}
	const { c, p } = await context(360, 'dark');
	for (const title of ['기존 제목', 'legacy-address', '다른 이름', '별칭 주소']) {
		await p.goto(base + '/new', { waitUntil: 'networkidle' });
		await titleSubmit(p, title);
		await p.getByText('같은 제목이나 주소를 사용하는 문서가 있습니다.', { exact: true }).waitFor();
		assert.equal(
			await p.getByRole('link', { name: '기존 문서 읽기', exact: true }).getAttribute('href'),
			'/wiki/legacy-address'
		);
		assert.equal(await p.getByLabel('새 문서 제목', { exact: true }).inputValue(), title);
	}
	await titleSubmit(p, '보관 문서');
	assert.equal(
		await p.getByRole('link', { name: '휴지통에서 확인', exact: true }).getAttribute('href'),
		'/trash?open=' + archived.id
	);
	await titleSubmit(p, '검토 대기');
	await p.getByRole('link', { name: '초안 검토하기', exact: true }).waitFor();
	await shot(p, 'pending-draft');
	for (const title of ['   ', '!!!', 'x'.repeat(201)]) {
		await p.goto(base + '/new?title=' + encodeURIComponent(title), { waitUntil: 'networkidle' });
		await p.getByRole('alert').waitFor();
		assert.equal(
			await p.getByLabel('새 문서 제목', { exact: true }).getAttribute('aria-invalid'),
			'true'
		);
	}
	// A query title can initialize a new editor, never rename an existing document.
	await p.goto(base + '/edit/legacy-address?title=' + encodeURIComponent('LEGACY Address'), {
		waitUntil: 'networkidle'
	});
	assert.equal(await p.getByLabel('문서 제목', { exact: true }).inputValue(), '기존 제목');
	await p.goto(base + '/edit/새-제목?title=' + encodeURIComponent('다른 제목'), {
		waitUntil: 'networkidle'
	});
	assert.equal(await p.getByLabel('문서 제목', { exact: true }).inputValue(), '새 제목');
	await c.close();
	reports.push({
		duplicates: 'title, canonical and legacy aliases, trash, pending draft',
		invalidTitles: true,
		existingTitlePreserved: true
	});
	const pending = await context(360, 'light');
	await pending.p.goto(base + '/new', { waitUntil: 'networkidle' });
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let lookups = 0;
	await pending.p.route('**/new/__data.json*', async (route) => {
		lookups++;
		await gate;
		await route.continue();
	});
	await pending.p.getByLabel('새 문서 제목', { exact: true }).fill('기존 제목');
	const started = pending.p.waitForRequest('**/new/__data.json*');
	const submitted = pending.p.getByRole('button', { name: '작성 시작', exact: true }).click();
	try {
		await started;
		assert.equal(
			await pending.p.getByRole('button', { name: '제목 확인 중…', exact: true }).isDisabled(),
			true
		);
		assert.equal(
			await pending.p.getByLabel('새 문서 제목', { exact: true }).inputValue(),
			'기존 제목'
		);
		assert.equal(await pending.p.locator('.wiki-form').getAttribute('aria-busy'), 'true');
		assert.equal(lookups, 1);
		await shot(pending.p, 'title-pending');
	} finally {
		release();
	}
	await submitted;
	await pending.p.getByRole('link', { name: '기존 문서 읽기', exact: true }).waitFor();
	await pending.c.close();
	reports.push({ pending: 'input retained; duplicate submission disabled' });
	const failure = await context(768, 'light');
	await failure.p.goto(base + '/new', { waitUntil: 'networkidle' });
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		await titleSubmit(failure.p, '장애 후 작성');
		await failure.p.getByRole('alert').waitFor();
		assert.equal(
			await failure.p.getByLabel('새 문서 제목', { exact: true }).inputValue(),
			'장애 후 작성'
		);
		assert.equal(new URL(failure.p.url()).pathname, '/new');
		await shot(failure.p, 'lookup-error');
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await titleSubmit(failure.p, '장애 후 작성');
	await failure.p.waitForURL('**/edit/**');
	assert.equal(
		await failure.p.getByLabel('문서 제목', { exact: true }).inputValue(),
		'장애 후 작성'
	);
	await failure.c.close();
	reports.push({ databaseFailure: 'title preserved; explicit retry reaches editor' });
	for (const width of [801, 1024, 1200]) {
		const resized = await context(width, 'light');
		await resized.p.goto(base + '/new', { waitUntil: 'networkidle' });
		const nav = await mainMenu(resized.p);
		for (const name of names)
			assert.equal(await nav.getByRole('link', { name, exact: true }).isVisible(), true);
		await noOverflow(resized.p);
		await shot(resized.p, 'intermediate-' + width);
		await resized.p.goto(base + '/wiki/navigation-check', { waitUntil: 'networkidle' });
		await resized.p.evaluate(() => scrollTo(0, 600));
		await resized.p.waitForFunction(() => scrollY > 500);
		const header = await resized.p.locator('.topbar').boundingBox();
		const aside = await resized.p.locator('.article-aside').boundingBox();
		assert.ok(aside.y >= header.y + header.height, 'sticky document aside stays below header');
		await shot(resized.p, 'reading-scroll-' + width);
		await resized.p
			.getByRole('navigation', { name: '목차', exact: true })
			.getByRole('link', { name: '2. 마지막 점검', exact: true })
			.click();
		await resized.p.waitForFunction(() => {
			const heading = document.getElementById('section-2').getBoundingClientRect();
			return (
				heading.y >= document.querySelector('.topbar').getBoundingClientRect().bottom &&
				heading.bottom < innerHeight
			);
		});

		await resized.c.close();
	}
	const nativeReading = await context(801, 'light', { javaScriptEnabled: false });
	await nativeReading.p.goto(base + '/wiki/navigation-check');
	await nativeReading.p.evaluate(() => scrollTo(0, 600));
	await nativeReading.p.waitForFunction(() => scrollY > 500);
	assert.ok(
		(await nativeReading.p.locator('.article-aside').boundingBox()).y >=
			(await nativeReading.p.locator('.topbar').boundingBox()).height
	);
	await nativeReading.c.close();
	reports.push({
		intermediateWidths: [801, 1024, 1200],
		reading: 'sticky aside and TOC clear the header; native fallback preserved'
	});
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/new', { waitUntil: 'networkidle' });
		await noOverflow(zoom.p);
		await shot(zoom.p, 'zoom200-' + theme);
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200, newEntryUsable: true });
	assert.deepEqual(await snapshot(), before, 'entry and validation must not change stored content');
	// Native GET and save must work without JavaScript, using the existing server action.
	const native = await context(360, 'light', { javaScriptEnabled: false });
	await native.p.goto(base + '/new');
	const createdTitle = 'JS 없는 새 문서 50%';
	await titleSubmit(native.p, createdTitle);
	await native.p.waitForURL('**/edit/**');
	assert.equal(await native.p.getByLabel('문서 제목', { exact: true }).inputValue(), createdTitle);
	await native.p.getByLabel('위키 본문', { exact: true }).fill('명시적으로 저장한 새 문서 본문');
	await native.p.getByRole('button', { name: '문서 저장', exact: true }).click();
	await native.p.waitForURL('**/wiki/**');
	const [saved] = await sql`SELECT * FROM documents WHERE title=${createdTitle}`;
	assert.ok(saved);
	assert.equal(saved.content, '명시적으로 저장한 새 문서 본문');
	assert.equal(
		(await sql`SELECT count(*)::int n FROM revisions WHERE document_id=${saved.id}`)[0].n,
		1
	);
	await native.c.close();
	reports.push({ noJavaScript: 'title entry and existing save action; one document and revision' });
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, output };
	await writeFile(output + '/entry-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
