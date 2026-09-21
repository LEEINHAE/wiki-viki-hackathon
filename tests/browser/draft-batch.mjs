import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.REVIEW_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-batch-review-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	base = 'http://127.0.0.1:4193';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const originalFetch = globalThis.fetch;
let gate = null,
	externalAttempts = 0,
	aiCalls = 0;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (url === 'https://api.openai.com/v1/responses') {
		aiCalls++;
		if (gate) await gate;
		return Response.json({
			object: 'response',
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: JSON.stringify({ passed: true, reasons: [] }) }]
				}
			]
		});
	}
	if (!url.startsWith(base + '/')) {
		externalAttempts++;
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
	server: { host: '127.0.0.1', port: 4193, strictPort: true, watch: null },
	plugins: [
		{
			name: 'batch-review-browser',
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
const pageErrors = [],
	reports = [],
	outbound = [];
async function seed(
	title,
	status = 'review',
	governance = {},
	content = '## 안내\n\n저장된 내용입니다. 검토 후 게시합니다.'
) {
	return (
		await sql`INSERT INTO drafts(title,slug,content,source_name,editor_handle,status,governance,aliases)
		VALUES (${title},${title},${content},'교대업무.xlsx','Editor-07',${status},${JSON.stringify(governance)},'[]') RETURNING id`
	)[0].id;
}
const select = (p, title) => p.getByRole('checkbox', { name: title + ' 선택', exact: true });
const submit = (p) => p.getByRole('button', { name: '선택한 초안 게시', exact: true });
async function shot(p, name) {
	await p.screenshot({ path: `${output}/${name}.png`, fullPage: true });
	await p.screenshot({ path: `${output}/${name}-viewport.png` });
}
async function observe(p) {
	p.on('pageerror', (e) => pageErrors.push(e.message));
	await p.route('**/*', (route) => {
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
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			await state.clearDatabase();
			state.env.OPENAI_API_KEY = 'test-only-key';
			aiCalls = 0;
			const a = await seed(
				'교대인계',
				'review',
				{},
				'## 인계 안내\n\n다음 근무자에게 운전 상태를 전달합니다. [[설비점검]] [^a]\n\n[^a]: 인계 기록\n\n![자료 그림](https://example.invalid/pixel.png)\n\n' +
					'업무 기록과 주의 사항을 확인합니다.\n\n'.repeat(28)
			);
			const b = await seed(
				'설비점검',
				'review',
				{},
				'## 안내\n\n압력계와 경보를 확인하고 이상을 기록합니다. [^a]\n\n[^a]: 점검 기록'
			);
			await seed('확인필요', 'blocked', {
				passed: false,
				regex: { reasons: ['본문을 확인해 주세요.'] }
			});
			const merge = await seed('통합검토', 'review', { merge: { id: 'existing-proposal' } });
			const conflict = await seed('기존용어');
			await sql`INSERT INTO documents(title,slug,content) VALUES ('기존용어','기존용어','보존할 기존 본문')`;
			const context = await browser.newContext({
				viewport: { width, height: 950 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			const p = await context.newPage();
			await observe(p);
			await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			assert.equal(await submit(p).isDisabled(), true);
			assert.equal(await p.locator('.review-row').count(), 5);
			assert.ok(
				(await p.getByRole('article', { name: '설비점검 저장된 본문' }).innerText()).includes(
					'압력계와 경보'
				)
			);
			for (const title of ['확인필요', '통합검토']) {
				assert.equal(await select(p, title).isDisabled(), false);
				await select(p, title).check();
				assert.equal(await submit(p).isDisabled(), true);
				await select(p, title).uncheck();
			}
			assert.equal(await p.locator('.review-body img').count(), 0);
			const ids = await p.locator('[id]').evaluateAll((nodes) => nodes.map((n) => n.id));
			assert.equal(new Set(ids).size, ids.length);
			await shot(p, `overview-${width}-${theme}`);
			await p.getByRole('button', { name: '본문 전체 보기 교대인계', exact: true }).click();
			assert.equal(
				await p
					.getByRole('button', { name: '본문 접기 교대인계', exact: true })
					.getAttribute('aria-expanded'),
				'true'
			);
			await shot(p, `normal-${width}-${theme}`);
			for (const title of ['교대인계', '설비점검', '기존용어']) {
				await select(p, title).focus();
				assert.equal(
					await select(p, title).evaluate((el) => {
						const box = el.getBoundingClientRect();
						return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el;
					}),
					true,
					'keyboard selection must remain visible below sticky controls'
				);
				await p.keyboard.press('Space');
			}
			let release;
			gate = new Promise((r) => (release = r));
			const response = p.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().includes('/drafts?/publishBatch')
			);
			response.catch(() => {});
			await submit(p).click();
			await p.getByText('선택한 초안을 검사하고 게시하고 있습니다.', { exact: false }).waitFor();
			assert.equal(await select(p, '교대인계').isDisabled(), true);
			assert.equal(
				await p.getByRole('button', { name: '선택 초안 게시 중…', exact: true }).isDisabled(),
				true
			);
			const warning = p.waitForEvent('dialog').then(async (dialog) => {
				assert.ok(dialog.message().includes('선택한 초안을 처리 중입니다.'));
				await dialog.dismiss();
			});
			await p
				.getByRole('navigation', { name: '초안 상태 필터' })
				.getByRole('link', { name: /확인 필요/ })
				.click();
			await warning;
			assert.equal(new URL(p.url()).search, '');
			await shot(p, `loading-${width}-${theme}`);
			release();
			gate = null;
			assert.equal((await response).status(), 200);
			await p
				.getByRole('heading', { name: '게시 결과 · 완료 2개 / 확인 필요 1개', exact: true })
				.waitFor();
			await p.waitForLoadState('networkidle');
			assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 2);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE slug='기존용어'`)[0].content,
				'보존할 기존 본문'
			);
			assert.equal(await p.locator('.review-row').count(), 3);
			assert.equal(await select(p, '기존용어').isChecked(), true);
			assert.equal(aiCalls, 3);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `partial-${width}-${theme}`);
			// Filtering clears hidden selections; it cannot publish invisible rows.
			await p
				.getByRole('navigation', { name: '초안 상태 필터' })
				.getByRole('link', { name: /확인 필요/ })
				.click();
			await p.waitForURL(/status=blocked/);
			assert.equal(await p.locator('.review-row').count(), 1);
			await p
				.getByRole('navigation', { name: '초안 상태 필터' })
				.getByRole('link', { name: /^전체/ })
				.click();
			await p.waitForURL(/status=all/);
			assert.equal(await select(p, '기존용어').isChecked(), false);
			// A changed version is shown as a failed result and never automatically re-approved.
			await select(p, '기존용어').check();
			await sql`UPDATE drafts SET content='다른 검토자의 최신 본문' WHERE id=${conflict}`;
			await submit(p).click();
			await p
				.getByRole('heading', { name: '게시 결과 · 완료 0개 / 확인 필요 1개', exact: true })
				.waitFor();
			await p.getByText('다른 검토자의 최신 본문', { exact: true }).waitFor();
			assert.equal(await select(p, '기존용어').isChecked(), false);
			// Existing deep links and individual editing/AI merge remain available.
			await p.locator(`a[href="/drafts?open=${merge}"]`).filter({ hasText: '수정·통합' }).click();
			await p.getByLabel('위키 본문', { exact: true }).waitFor();
			await p.getByRole('region', { name: '기존 문서와 AI 통합', exact: true }).waitFor();
			for (const id of [a, b])
				assert.equal((await sql`SELECT status FROM drafts WHERE id=${id}`)[0].status, 'published');
			reports.push({
				width,
				theme,
				listPreview: true,
				partialPublication: '2 completed, 1 preserved conflict',
				staleSelection: 're-review required'
			});
			await context.close();
		}
	// Select-all is bounded and does not carry approvals into a different page or filter.
	await state.clearDatabase();
	state.env.OPENAI_API_KEY = '';
	for (let i = 0; i < 21; i++) await seed(`목록선택${i}`);
	const paged = await browser.newPage({ viewport: { width: 720, height: 475 } });
	await observe(paged);
	await paged.goto(base + '/drafts', { waitUntil: 'networkidle' });
	await paged.getByRole('button', { name: '게시할 8개 선택', exact: true }).click();
	assert.equal(await paged.locator('input[name="draft"]:checked').count(), 8);
	assert.equal(await submit(paged).isDisabled(), false);
	await paged.getByRole('button', { name: '선택 해제', exact: true }).click();
	await paged.getByRole('button', { name: '전체 선택', exact: true }).click();
	assert.equal(await paged.locator('input[name="draft"]:checked').count(), 20);
	assert.equal(await submit(paged).isDisabled(), true);
	await paged
		.getByRole('navigation', { name: '초안 상태 필터' })
		.getByRole('link', { name: /^검토 대기/ })
		.click();
	await paged.waitForURL(/status=review/);
	assert.equal(await paged.locator('input[name="draft"]:checked').count(), 0);
	await paged.getByRole('button', { name: '전체 선택', exact: true }).click();
	await paged.getByRole('link', { name: '다음 →', exact: true }).click();
	await paged.waitForURL(/page=2/);
	assert.equal(await paged.locator('.review-row').count(), 1);
	assert.equal(await paged.locator('input[name="draft"]:checked').count(), 0);
	await paged.getByRole('button', { name: '전체 선택', exact: true }).click();
	assert.equal(await paged.locator('input[name="draft"]:checked').count(), 1);
	await shot(paged, 'small-height-pagination');
	await paged.close();
	// Response loss after the real commit: the same selected versions are safe to resend.
	await state.clearDatabase();
	state.env.OPENAI_API_KEY = '';
	await seed('응답유실하나');
	await seed('응답유실둘');
	const p = await browser.newPage();
	await observe(p);
	await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
	await select(p, '응답유실하나').check();
	await select(p, '응답유실둘').check();
	await p.route(
		(url) => url.pathname === '/drafts' && url.searchParams.has('/publishBatch'),
		async (route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			await route.fetch();
			await route.abort();
		},
		{ times: 1 }
	);
	await submit(p).click();
	await p.getByRole('alert').filter({ hasText: '게시 결과를 확인하지 못했습니다.' }).waitFor();
	assert.equal((await sql`SELECT count(*)::int n FROM documents`)[0].n, 2);
	assert.equal(await select(p, '응답유실하나').isChecked(), true);
	await submit(p).click();
	await p
		.getByRole('heading', { name: '게시 결과 · 완료 2개 / 확인 필요 0개', exact: true })
		.waitFor();
	assert.equal(
		await p.getByText('이미 게시됨 · 중복 생성하지 않았습니다.', { exact: true }).count(),
		2
	);
	assert.equal((await sql`SELECT count(*)::int n FROM revisions`)[0].n, 2);
	await p.getByText('지금은 검토할 초안이 없어요.', { exact: true }).waitFor();
	await shot(p, 'empty-after-retry');
	await p.close();
	// Native form fallback has the same review/version protections and no extra confirmation step.
	await state.clearDatabase();
	await seed('기본폼하나', 'review', {}, '긴 본문을 모두 읽고 검토합니다.\n\n'.repeat(30));
	await seed('기본폼둘');
	const nojs = await browser.newContext({
		javaScriptEnabled: false,
		viewport: { width: 360, height: 850 }
	});
	const basic = await nojs.newPage();
	await observe(basic);
	await basic.goto(base + '/drafts');
	assert.equal(await basic.locator('.review-body.collapsed').count(), 0);
	await select(basic, '기본폼하나').check();
	await select(basic, '기본폼둘').check();
	await submit(basic).click();
	await basic
		.getByRole('heading', { name: '게시 결과 · 완료 2개 / 확인 필요 0개', exact: true })
		.waitFor();
	assert.equal((await sql`SELECT count(*)::int n FROM documents`)[0].n, 2);
	await nojs.close();
	// A database outage is an error state, never an empty queue or fabricated counts.
	const errorPage = await browser.newPage();
	await observe(errorPage);
	await sql`ALTER TABLE drafts RENAME TO temporarily_unavailable_drafts`;
	try {
		await errorPage.goto(base + '/drafts');
		await errorPage.getByRole('alert').filter({ hasText: '초안을 불러오지 못했습니다.' }).waitFor();
		assert.equal(await submit(errorPage).count(), 0);
		await shot(errorPage, 'database-error');
	} finally {
		await sql`ALTER TABLE temporarily_unavailable_drafts RENAME TO drafts`;
	}
	await errorPage.close();
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	assert.deepEqual(outbound, []);
	reports.push({
		lostResponse: 'committed once; retry recognized prior publication',
		noJavaScript: '2 published',
		databaseFailure: 'explicit error'
	});
	await writeFile(
		output + '/batch-browser-results.json',
		JSON.stringify({ reports, pageErrors, externalAttempts, outbound, mockedAI: true }, null, 2)
	);
	console.log(
		JSON.stringify(
			{ reports, pageErrors, externalAttempts, outbound, mockedAI: true, output },
			null,
			2
		)
	);
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
