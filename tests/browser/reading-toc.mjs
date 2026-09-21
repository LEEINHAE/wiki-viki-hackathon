import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.TOC_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-reading-toc-')));
const base = 'http://127.0.0.1:4183',
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
	server: { host: '127.0.0.1', port: 4183, strictPort: true, watch: null },
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

const sections = Array.from({ length: 18 }, (_, i) => ({
	title: i === 0 ? '첫 점검' : i === 1 ? '세부 확인' : i === 2 ? '판단 기준' : `점검 단계 ${i + 1}`,
	level: i === 1 ? 3 : i === 2 ? 4 : 2
}));
const content =
	sections
		.map(
			({ title, level }, i) =>
				'#'.repeat(level) +
				' ' +
				title +
				'\n\n' +
				Array.from(
					{ length: 6 },
					() =>
						`가상 교육 자료의 ${i + 1}번째 점검 내용입니다. 절차와 조건을 충분히 확인한 뒤 다음 단계로 이동합니다. 상세 설명을 읽어 문서의 흐름을 파악합니다.`
				).join('\n\n')
		)
		.join('\n\n') +
	'\n\n검토 근거[^review]와 [[reference|참고 문서]]\n\n[^review]: 가상 점검 기준입니다.';
const [doc] =
	await sql`INSERT INTO documents(title,slug,content) VALUES('긴 문서 목차','reading-toc',${content}) RETURNING *`;
await sql`INSERT INTO documents(title,slug,content) VALUES('참고 문서','reference','제목 없는 짧은 설명입니다. [[reading-toc|긴 문서 목차]]')`;
await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${content},'Editor-01')`;
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM revisions d),'redirects',(SELECT jsonb_agg(to_jsonb(d) ORDER BY alias_slug) FROM redirects d),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) data`
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

async function current(p, id) {
	await p.waitForFunction(
		(id) =>
			[...document.querySelectorAll('.toc a[aria-current="location"]')].some(
				(a) => a.getAttribute('href') === '#' + id
			),
		id
	);
}
async function aligned(p, id) {
	try {
		await p.waitForFunction(
			(id) => {
				const h = document.getElementById(id).getBoundingClientRect();
				const header = document.querySelector('.topbar').getBoundingClientRect();
				const summary = document
					.querySelector('.article-mobile-toc summary')
					?.getBoundingClientRect();
				const edge = summary?.height ? Math.max(header.bottom, summary.bottom) : header.bottom;
				return h.top >= edge && h.bottom < innerHeight;
			},
			id,
			{ timeout: 5000 }
		);
	} catch (error) {
		console.log(
			'Alignment failure',
			await p.evaluate(
				(id) => ({
					heading: document.getElementById(id).getBoundingClientRect().toJSON(),
					header: document.querySelector('.topbar').getBoundingClientRect().toJSON(),
					summary: document
						.querySelector('.article-mobile-toc summary')
						?.getBoundingClientRect()
						.toJSON(),
					scrollY
				}),
				id
			)
		);
		await shot(p, 'alignment-failure');
		throw error;
	}
}
async function noOverflow(p) {
	assert.equal(
		await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false
	);
}
try {
	const footnote = await context(360, 'dark');
	await footnote.p.goto(base + '/wiki/reading-toc#fn-review', { waitUntil: 'networkidle' });
	await aligned(footnote.p, 'fn-review');
	await footnote.p.goto(base + '/wiki/reading-toc#section-18', { waitUntil: 'networkidle' });
	await footnote.p.locator('.footnote-ref a').click();
	await aligned(footnote.p, 'fn-review');
	await shot(footnote.p, 'footnote');
	await footnote.c.close();
	reports.push({
		footnotes: 'existing direct and clicked footnote targets remain below the mobile bar'
	});
	const keyboard = await context(1440, 'light');
	await keyboard.p.goto(base + '/wiki/reading-toc', { waitUntil: 'networkidle' });
	await keyboard.p
		.getByRole('navigation', { name: '문서 작업', exact: true })
		.getByRole('link', { name: '역사', exact: true })
		.focus();
	await keyboard.p.keyboard.press('Tab');
	assert.equal(
		await keyboard.p.evaluate(() => document.activeElement.textContent.trim()),
		'목차로 이동',
		'TOC remains directly reachable before traversing body links'
	);
	await keyboard.p.keyboard.press('Enter');
	assert.equal(
		await keyboard.p.evaluate(() => document.activeElement.closest('.article-side-toc') !== null),
		true
	);
	await keyboard.p.keyboard.press('Enter');
	await aligned(keyboard.p, 'section-1');
	assert.equal(await keyboard.p.evaluate(() => document.activeElement.id), 'section-1');
	await keyboard.c.close();
	reports.push({ keyboardEntry: 'document actions to TOC to body via Tab and Enter' });
	const first = await context(1440, 'light');
	await first.p.goto(base + '/wiki/reading-toc#section-3', { waitUntil: 'networkidle' });
	await shot(first.p, 'before-or-first');
	assert.ok(
		await first.p.locator('.toc a[aria-current="location"]').count(),
		'reading position must be represented in the table of contents'
	);
	await first.c.close();
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { c, p } = await context(width, theme);
			await p.goto(base + '/wiki/reading-toc#section-3', { waitUntil: 'networkidle' });
			await current(p, 'section-3');
			await aligned(p, 'section-3');
			if (width <= 800) await p.locator('.article-mobile-toc summary').click();
			const toc = p.getByRole('navigation', { name: '목차', exact: true });
			assert.equal(await toc.getByRole('link').count(), 18);
			assert.equal(
				await toc.getByRole('link', { name: '1.1.1. 판단 기준', exact: true }).getAttribute('href'),
				'#section-3'
			);
			await shot(p, 'toc-' + width + '-' + theme);
			const last = toc.getByRole('link', { name: '16. 점검 단계 18', exact: true });
			await last.focus();
			await p.keyboard.press('Enter');
			await p.waitForURL('**/reading-toc#section-18');
			await current(p, 'section-18');
			await aligned(p, 'section-18');
			assert.equal(await p.evaluate(() => document.activeElement.id), 'section-18');
			if (width <= 800) {
				assert.equal(await p.locator('.article-mobile-toc').getAttribute('open'), null);
				await p.locator('.article-mobile-toc summary').click();
				await p.getByRole('link', { name: '본문으로 돌아가기', exact: true }).focus();
				await p.keyboard.press('Enter');
				assert.equal(await p.locator('.article-mobile-toc').getAttribute('open'), null);
				await aligned(p, 'section-18');
				await p.locator('.article-mobile-toc summary').click();
				await toc.getByRole('link').first().focus();
				await p.keyboard.press('Escape');
				assert.equal(
					await p.evaluate(() => document.activeElement.matches('.article-mobile-toc summary')),
					true
				);
				assert.equal(await p.locator('.article-mobile-toc').getAttribute('open'), null);
				await p.locator('.article-mobile-toc summary').click();
				await toc.getByRole('link').last().focus();
				await p.keyboard.press('Tab');
				assert.equal(
					await p.locator('.article-mobile-toc').getAttribute('open'),
					null,
					'Tab into body closes the overlay'
				);
				assert.equal(
					await p.evaluate(() => document.activeElement.closest('.wiki-content') !== null),
					true
				);
			}
			await p.evaluate(() =>
				scrollTo(
					0,
					document.getElementById('section-6').getBoundingClientRect().top + scrollY - 200
				)
			);
			// Scroll past the heading into its paragraph without changing the URL fragment.
			await p.evaluate(() => scrollBy(0, 160));
			await current(p, 'section-6');
			assert.equal(new URL(p.url()).hash, '#section-18');
			await noOverflow(p);
			await shot(p, 'reading-' + width + '-' + theme);
			await c.close();
			reports.push({
				width,
				theme,
				anchors: 'existing IDs and hierarchy',
				keyboard: 'focus, collapse and return',
				scroll: 'current section without URL writes'
			});
		}

	// A responsive transition must not leave keyboard focus inside a hidden copy.
	const resized = await context(1440, 'light');
	await resized.p.goto(base + '/wiki/reading-toc#section-3', { waitUntil: 'networkidle' });
	await resized.p.locator('.article-side-toc a[href="#section-6"]').focus();
	await resized.p.setViewportSize({ width: 360, height: 1000 });
	await resized.p.waitForFunction(() =>
		document.activeElement.matches('.article-mobile-toc summary')
	);
	await resized.p.keyboard.press('Enter');
	await resized.p.locator('.article-mobile-toc a[href="#section-6"]').focus();
	await resized.p.setViewportSize({ width: 1440, height: 1000 });
	await resized.p.waitForFunction(() =>
		document.activeElement.matches('.article-side-toc a[href="#section-6"]')
	);
	await noOverflow(resized.p);
	await resized.c.close();
	reports.push({ responsiveFocus: 'visible matching TOC or mobile summary' });
	for (const width of [360, 801]) {
		const native = await context(width, 'light', { javaScriptEnabled: false });
		await native.p.goto(base + '/wiki/reading-toc#section-3');
		await aligned(native.p, 'section-3');
		if (width > 800) {
			await native.p
				.getByRole('navigation', { name: '문서 작업', exact: true })
				.getByRole('link', { name: '역사', exact: true })
				.focus();
			await native.p.keyboard.press('Tab');
			assert.equal(
				await native.p.evaluate(() => document.activeElement.textContent.trim()),
				'목차로 이동'
			);
			await native.p.keyboard.press('Enter');
			assert.equal(
				await native.p.evaluate(() => document.activeElement.id),
				'desktop-document-toc'
			);
			await native.p.keyboard.press('Tab');
			assert.equal(
				await native.p.evaluate(() => document.activeElement.closest('.article-side-toc') !== null),
				true
			);
		}

		if (width <= 800) await native.p.locator('.article-mobile-toc summary').click();
		const toc = native.p.getByRole('navigation', { name: '목차', exact: true });
		await toc.getByRole('link', { name: '16. 점검 단계 18', exact: true }).click();
		await aligned(native.p, 'section-18');
		assert.equal(new URL(native.p.url()).hash, '#section-18');
		assert.equal(
			await native.p.locator('.toc [aria-current]').count(),
			0,
			'no fabricated reading state without JavaScript'
		);
		await noOverflow(native.p);
		await native.c.close();
	}
	reports.push({ native: 'disclosure and original fragment links without JavaScript' });
	const navigation = await context(360, 'dark');
	await navigation.p.goto(base + '/wiki/reading-toc#section-6', { waitUntil: 'networkidle' });
	await current(navigation.p, 'section-6');
	const related = navigation.p.locator('.related-link').filter({ hasText: '참고 문서' });
	await related.scrollIntoViewIfNeeded();
	await current(navigation.p, 'section-18');
	const previousY = await navigation.p.evaluate(() => scrollY);
	await related.click();
	await navigation.p.getByRole('heading', { name: '참고 문서', exact: true }).waitFor();
	assert.equal(await navigation.p.locator('.toc').count(), 0);
	await navigation.p.goBack({ waitUntil: 'networkidle' });
	await current(navigation.p, 'section-18');
	assert.equal(new URL(navigation.p.url()).hash, '#section-6');
	assert.ok(
		Math.abs((await navigation.p.evaluate(() => scrollY)) - previousY) < 3,
		'back restores reading position instead of forcing stale fragment'
	);
	await navigation.p.goto(base + '/wiki/reading-toc#document-toc', { waitUntil: 'networkidle' });
	await navigation.p.locator('.article-mobile-toc summary').click();
	await navigation.p.getByRole('navigation', { name: '목차', exact: true }).waitFor();
	await navigation.p.goto(base + '/wiki/reading-toc#%E0%A4%A', { waitUntil: 'networkidle' });
	await current(navigation.p, 'section-1');
	await navigation.c.close();
	reports.push({
		navigation: 'no-heading document cleanup, legacy TOC fragment and restored scroll'
	});
	for (const theme of ['light', 'dark']) {
		const zoom = await context(720, theme, {
			viewport: { width: 720, height: 500 },
			deviceScaleFactor: 2
		});
		await zoom.p.goto(base + '/wiki/reading-toc#section-3', { waitUntil: 'networkidle' });
		await aligned(zoom.p, 'section-3');
		await zoom.p.locator('.article-mobile-toc summary').click();
		const bounds = await zoom.p.locator('.toc-mobile-panel').boundingBox();
		assert.ok(bounds.y + bounds.height <= 500);
		await zoom.p
			.getByRole('navigation', { name: '목차', exact: true })
			.getByRole('link')
			.last()
			.focus();
		await zoom.p.keyboard.press('Enter');
		await aligned(zoom.p, 'section-18');
		await noOverflow(zoom.p);
		await shot(zoom.p, 'zoom200-' + theme);
		await zoom.c.close();
	}
	reports.push({ zoomEquivalent: 200, shortMobile: 'scrollable list stays inside viewport' });
	const short = await context(1440, 'dark', { viewport: { width: 1440, height: 400 } });
	await short.p.goto(base + '/wiki/reading-toc#section-18', { waitUntil: 'networkidle' });
	await current(short.p, 'section-18');
	const aside = await short.p.locator('.article-aside').boundingBox();
	const selected = await short.p
		.locator('.article-side-toc [aria-current="location"]')
		.boundingBox();
	assert.ok(selected.y >= aside.y && selected.y + selected.height <= aside.y + aside.height);
	await aligned(short.p, 'section-18');
	await shot(short.p, 'short-desktop');
	await short.c.close();
	reports.push({ shortDesktop: 'current entry visible in scrollable sticky sidebar' });
	const pending = await context(360, 'light');
	await pending.p.goto(base + '/wiki/reference', { waitUntil: 'networkidle' });
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	await pending.p.route('**/wiki/reading-toc/__data.json*', async (route) => {
		await gate;
		await route.continue();
	});
	await pending.p.locator('.wiki-content a').focus();
	const started = pending.p.waitForRequest('**/wiki/reading-toc/__data.json*');
	const move = pending.p.keyboard.press('Enter');
	try {
		await started;
		await pending.p.getByRole('heading', { name: '참고 문서', exact: true }).waitFor();
		assert.equal(await pending.p.locator('.toc').count(), 0);
	} finally {
		release();
	}
	await move;
	await pending.p.getByRole('heading', { name: '긴 문서 목차', exact: true }).waitFor();
	await current(pending.p, 'section-1');
	await pending.c.close();
	reports.push({ loading: 'previous document stays readable until new content arrives' });
	const failure = await context(360, 'light');
	await failure.p.goto(base + '/wiki/missing-toc', { waitUntil: 'networkidle' });
	assert.equal(await failure.p.locator('.toc').count(), 0);
	await sql`ALTER TABLE documents RENAME TO documents_unavailable`;
	try {
		const response = await failure.p.goto(base + '/wiki/reading-toc', { waitUntil: 'networkidle' });
		assert.equal(response.status(), 503);
		assert.equal(await failure.p.locator('.toc').count(), 0);
		await shot(failure.p, 'lookup-error');
	} finally {
		await sql`ALTER TABLE documents_unavailable RENAME TO documents`;
	}
	await failure.p.getByRole('link', { name: '다시 불러오기', exact: true }).click();
	await current(failure.p, 'section-1');
	await failure.c.close();
	reports.push({ missingAndError: 'no stale TOC; actual DB failure and retry' });
	assert.deepEqual(await snapshot(), before);
	assert.deepEqual(errors, []);
	assert.equal(externalCalls, 0);
	const result = { reports, errors, externalCalls, unchangedDatabase: true, output };
	await writeFile(output + '/toc-results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
