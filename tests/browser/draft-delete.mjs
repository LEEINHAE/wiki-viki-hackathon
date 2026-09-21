import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.DELETE_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-delete-')));
await mkdir(output, { recursive: true });
const fixture = root + '/tests/fixtures/governance-database.js',
	base = 'http://127.0.0.1:4193';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const originalFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
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
			name: 'delete-browser',
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
state.env.OPENAI_API_KEY = 'test-only-key';
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = [],
	pageErrors = [];
const select = (p, title) => p.getByRole('checkbox', { name: title + ' 선택', exact: true });
const confirm = (p) =>
	p.getByRole('checkbox', {
		name: '선택한 초안을 영구 삭제하며 복구할 수 없음을 확인했습니다.',
		exact: true
	});
const remove = (p) => p.getByRole('button', { name: '선택한 초안 삭제', exact: true });
const publish = (p) => p.getByRole('button', { name: '선택한 초안 게시', exact: true });
const seed = async (title, status = 'review', governance = {}) =>
	(
		await sql`INSERT INTO drafts(title,slug,content,source_name,status,governance) VALUES (${title},${title},'보존된 원문','test.xlsx',${status},${JSON.stringify(governance)}) RETURNING id`
	)[0].id;
const count = async () =>
	(await sql`SELECT count(*)::int n FROM drafts WHERE status<>'published'`)[0].n;
async function observe(p) {
	p.on('pageerror', (e) => pageErrors.push(e.message));
	await p.route('**/*', (route) => {
		if (
			!route
				.request()
				.url()
				.startsWith(base + '/')
		) {
			externalAttempts++;
			return route.abort();
		}
		return route.continue();
	});
}
async function submit(p) {
	const pending = p.waitForResponse(
		(r) => r.request().method() === 'POST' && r.url().includes('/deleteBatch')
	);
	await remove(p).click();
	const response = await pending;
	// Enhanced SvelteKit actions transport failure status in their JSON envelope.
	const result = response.headers()['content-type']?.includes('application/json')
		? await response.json()
		: null;
	return { status: () => result?.status || response.status() };
}
async function shot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png' });
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			await state.clearDatabase();
			const a = await seed('삭제할 일반 초안');
			await seed('삭제할 확인 필요 초안', 'blocked', { passed: false });
			await seed('삭제할 통합 초안', 'review', { merge: { id: 'stored' } });
			const keep = await seed('남길 초안');
			await seed('게시된 초안', 'published');
			await sql`INSERT INTO documents(title,slug,content) VALUES ('기존 문서','existing','변경 금지')`;
			const context = await browser.newContext({
				viewport: { width, height: 850 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			const p = await context.newPage();
			await observe(p);
			await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
			assert.equal(await remove(p).isDisabled(), true);
			assert.equal(await confirm(p).isDisabled(), true);
			for (const title of ['삭제할 일반 초안', '삭제할 확인 필요 초안', '삭제할 통합 초안']) {
				await select(p, title).focus();
				await p.keyboard.press('Space');
			}
			assert.equal(await publish(p).isDisabled(), true);
			assert.equal(await remove(p).isDisabled(), true);
			await confirm(p).check();
			await select(p, '남길 초안').check();
			assert.equal(await confirm(p).isChecked(), false);
			await select(p, '남길 초안').uncheck();
			await confirm(p).focus();
			await p.keyboard.press('Space');
			await remove(p).focus();
			await shot(p, `selected-${width}-${theme}`);
			const locked = Promise.withResolvers(),
				release = Promise.withResolvers();
			const gate = sql.begin(async (tx) => {
				await tx`SELECT id FROM drafts WHERE id=${a} FOR UPDATE`;
				locked.resolve();
				await release.promise;
			});
			gate.catch(locked.reject);
			let pending;
			try {
				await locked.promise;
				pending = submit(p);
				await p.getByText('선택한 초안을 삭제하고 있습니다.', { exact: false }).waitFor();
				assert.equal(
					await p.getByRole('button', { name: '선택 초안 삭제 중…', exact: true }).isDisabled(),
					true
				);
				assert.equal(await publish(p).isDisabled(), true);
				assert.equal(await select(p, '남길 초안').isDisabled(), true);
				await shot(p, `loading-${width}-${theme}`);
			} finally {
				release.resolve();
				await gate;
			}
			assert.equal((await pending).status(), 200);
			await p.getByRole('heading', { name: '삭제 완료 · 3개', exact: true }).waitFor();
			assert.equal(await count(), 1);
			assert.equal(
				(await sql`SELECT content FROM drafts WHERE id=${keep}`)[0].content,
				'보존된 원문'
			);
			assert.equal((await sql`SELECT content FROM documents`)[0].content, '변경 금지');
			assert.equal(await p.locator('input[name="draft"]:checked').count(), 0);
			assert.equal(await confirm(p).isChecked(), false);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `success-${width}-${theme}`);
			reports.push({
				width,
				theme,
				deleted: 3,
				unselectedPreserved: true,
				keyboard: true,
				pendingDisabled: true
			});
			await context.close();
		}
	// All-or-nothing conflict and retry using the newly loaded version.
	await state.clearDatabase();
	await seed('충돌시 유지');
	const changed = await seed('동시 수정');
	const p = await browser.newPage({ viewport: { width: 360, height: 850 } });
	await observe(p);
	await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
	await p.getByRole('button', { name: '전체 선택', exact: true }).click();
	await confirm(p).check();
	await sql`UPDATE drafts SET content='새로운 원문' WHERE id=${changed}`;
	assert.equal((await submit(p)).status(), 409);
	await p
		.getByRole('alert')
		.filter({ hasText: '이번 요청에서는 아무 초안도 삭제하지 않았습니다.' })
		.waitFor();
	assert.equal(await count(), 2);
	assert.equal(await confirm(p).isChecked(), false);
	await shot(p, 'conflict');
	await p.getByRole('button', { name: '목록 새로 확인', exact: true }).click();
	await p.getByText('새로운 원문', { exact: true }).waitFor();
	await p.waitForFunction(
		() => document.querySelectorAll('input[name="draft"]:checked').length === 1
	);
	await select(p, '동시 수정').check();
	assert.equal(await p.locator('input[name="draft"]:checked').count(), 2);
	await confirm(p).check();
	assert.equal((await submit(p)).status(), 200);
	await p.getByRole('heading', { name: '삭제 완료 · 2개', exact: true }).waitFor();
	await p.getByText('지금은 검토할 초안이 없어요.', { exact: true }).waitFor();
	reports.push({ conflict: 'none deleted; reviewed retry removed both' });
	// A real database trigger failure must preserve selection and every draft.
	await seed('실패시 유지 하나');
	const failId = await seed('실패시 유지 둘');
	await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
	await p.getByRole('button', { name: '전체 선택', exact: true }).click();
	await confirm(p).check();
	await sql.unsafe(
		`CREATE FUNCTION browser_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id=${failId} THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN OLD; END $$; CREATE TRIGGER browser_delete_failure BEFORE DELETE ON drafts FOR EACH ROW EXECUTE FUNCTION browser_delete_failure()`
	);
	try {
		assert.equal((await submit(p)).status(), 503);
		await p.getByRole('alert').filter({ hasText: '삭제 결과를 확인하지 못했습니다.' }).waitFor();
		assert.equal(await count(), 2);
		assert.equal(await p.locator('input[name="draft"]:checked').count(), 2);
		assert.equal(await confirm(p).isChecked(), false);
		await shot(p, 'database-failure');
	} finally {
		await sql.unsafe(
			'DROP TRIGGER browser_delete_failure ON drafts; DROP FUNCTION browser_delete_failure()'
		);
	}
	await confirm(p).check();
	assert.equal((await submit(p)).status(), 200);
	await p.getByText('지금은 검토할 초안이 없어요.', { exact: true }).waitFor();
	reports.push({ databaseFailure: 'all preserved; retry completed' });
	// Last-page removal clamps pagination; selecting 20 never enables publication.
	for (let i = 0; i < 21; i++) await seed(`페이지 초안 ${i}`);
	await p.goto(base + '/drafts?status=review&page=2', { waitUntil: 'networkidle' });
	await p.getByRole('button', { name: '전체 선택', exact: true }).click();
	await confirm(p).check();
	assert.equal((await submit(p)).status(), 200);
	await p.getByRole('heading', { name: '삭제 완료 · 1개', exact: true }).waitFor();
	assert.equal(await p.locator('.review-row').count(), 20);
	assert.equal(await p.locator('input[name="draft"]:checked').count(), 0);
	await p.getByRole('button', { name: '전체 선택', exact: true }).click();
	assert.equal(await p.locator('input[name="draft"]:checked').count(), 20);
	assert.equal(await publish(p).isDisabled(), true);
	await confirm(p).check();
	assert.equal((await submit(p)).status(), 200);
	await p.getByRole('heading', { name: '삭제 완료 · 20개', exact: true }).waitFor();
	await p.getByText('지금은 검토할 초안이 없어요.', { exact: true }).waitFor();
	await shot(p, 'empty-after-page-delete');
	reports.push({ pageLimit: 20, lastPageClamped: true });
	// Lost response after the actual commit keeps selection until explicit refresh.
	await seed('응답 유실 초안');
	await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
	await p.getByRole('button', { name: '전체 선택', exact: true }).click();
	await confirm(p).check();
	await p.route(
		(url) => url.pathname === '/drafts' && url.searchParams.has('/deleteBatch'),
		async (route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			await route.fetch();
			await route.abort();
		},
		{ times: 1 }
	);
	await remove(p).click();
	await p.getByRole('alert').filter({ hasText: '삭제 결과를 확인하지 못했습니다.' }).waitFor();
	assert.equal(await count(), 0);
	assert.equal(await select(p, '응답 유실 초안').isChecked(), true);
	await p.getByRole('button', { name: '목록 새로 확인', exact: true }).click();
	await p.getByText('지금은 검토할 초안이 없어요.', { exact: true }).waitFor();
	reports.push({ lostResponse: 'selection retained; refresh reflects deletion' });
	await p.close();
	// No-JavaScript forms retain confirmation and version validation.
	await seed('기본폼 일반');
	await seed('기본폼 확인 필요', 'blocked');
	const context = await browser.newContext({
		javaScriptEnabled: false,
		viewport: { width: 768, height: 850 }
	});
	const basic = await context.newPage();
	await observe(basic);
	await basic.goto(base + '/drafts');
	await select(basic, '기본폼 일반').check();
	await select(basic, '기본폼 확인 필요').check();
	assert.equal((await submit(basic)).status(), 400);
	await basic.getByRole('alert').filter({ hasText: '영구 삭제 확인 항목' }).waitFor();
	assert.equal(await count(), 2);
	assert.equal(await basic.locator('input[name="draft"]:checked').count(), 2);
	await confirm(basic).check();
	assert.equal((await submit(basic)).status(), 200);
	await basic.getByRole('heading', { name: '삭제 완료 · 2개', exact: true }).waitFor();
	await basic.getByText('지금은 검토할 초안이 없어요.', { exact: true }).waitFor();
	reports.push({ noJavaScript: 'confirmation enforced; both removed' });
	await context.close();
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/results.json',
		JSON.stringify({ reports, pageErrors, externalAttempts }, null, 2)
	);
	console.log(JSON.stringify({ reports, pageErrors, externalAttempts, output }, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
