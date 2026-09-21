import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyPreviewResizeFocus } from '../fixtures/preview-focus.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.DRAFT_PREVIEW_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-draft-preview-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	base = 'http://127.0.0.1:4196';
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
	server: { host: '127.0.0.1', port: 4196, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-draft-preview-browser',
			enforce: 'pre',
			resolveId(id) {
				if ([root + '/src/lib/server/db.js', '$lib/server/db.js', './db.js'].includes(id))
					return fixture;
			}
		}
	]
});
const state = await server.ssrLoadModule(fixture);
await state.setupDatabase({ maxConnections: 4 });
state.env.OPENAI_API_KEY = '';
const sql = state.db();
const { getDraft } = await server.ssrLoadModule('/src/lib/server/draft-write.js');
const { getEditableDocument } = await server.ssrLoadModule('/src/lib/server/document-write.js');
const { createProposal, saveProposal } = await server.ssrLoadModule(
	'/src/lib/server/draft-merge.js'
);
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [],
	reports = [],
	outbound = [];
const ordinary = (p) => p.getByRole('group', { name: '위키 본문 편집기', exact: true });
const finalEditor = (p) => p.getByRole('group', { name: '최종 통합 본문 편집기', exact: true });
const body = (p) => p.getByLabel('위키 본문', { exact: true });
const finalBody = (p) => p.getByLabel('최종 통합 본문', { exact: true });
const confirm = (p) => p.locator('[name="confirmMerge"]');
const publish = (p) => p.getByRole('button', { name: '검토 완료 · 문서 게시', exact: true });
const apply = (p) => p.getByRole('button', { name: '검토 완료 · 기존 문서에 통합', exact: true });
const source = '## 저장된 초안\n\n원래 초안 본문 [^same]\n\n[^same]: 원래 각주';
async function seed() {
	await state.clearDatabase();
	const [target] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('기존 설비','fixed-target','기존 보관 정보') RETURNING *`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('original-alias','Original Alias',${target.id})`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${target.id},${target.content},'Editor-01')`;
	const [draft] =
		await sql`INSERT INTO drafts(title,slug,content,aliases,governance) VALUES('검토 초안','검토-초안',${source},'["새 별칭"]','{"passed":true}') RETURNING *`;
	const current = await getDraft(sql, draft.id),
		destination = await getEditableDocument('', target.id);
	const proposal = createProposal(current, destination, {
		model: 'test-only',
		result: {
			content:
				'## 통합 원안\n\n기존 보관 정보와 초안 내용을 검토합니다. [^same]\n\n[^same]: 통합 원안 각주',
			summary: '합성 자료 통합',
			conflicts: []
		}
	});
	assert.equal(await saveProposal(sql, current, destination, proposal), true);
	return { draft, target, proposal };
}
async function page(width, theme, draft) {
	const c = await browser.newContext({
		viewport: { width, height: 1000 },
		deviceScaleFactor: width === 720 ? 2 : 1,
		reducedMotion: 'reduce'
	});
	await c.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
	await c.route('**/*', (route) => {
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
	const p = await c.newPage();
	p.on('pageerror', (error) => errors.push(error.message));
	p.on('console', (message) => {
		if (message.type() === 'warning' && message.text().includes('[svelte]'))
			errors.push(message.text());
	});
	p.on('dialog', (dialog) => dialog.dismiss());
	await p.goto(base + '/drafts?open=' + draft.id, { waitUntil: 'networkidle' });
	return { c, p };
}
async function view(editor, mode) {
	await editor.locator('.preview-panel').waitFor({ state: 'attached' });
	const tab = editor.getByRole('tab', { name: mode, exact: true });
	if (await tab.count()) await tab.click();
}
async function rendered(editor, text) {
	await view(editor, '미리보기');
	await editor.locator('.wiki-content').getByText(text, { exact: false }).first().waitFor();
}
async function screenshot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
	await p.screenshot({ path: output + '/' + name + '-viewport.png' });
}
const snapshot = async () =>
	(
		await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r)) data`
	)[0].data;
try {
	for (const width of [360, 768, 1440, 720])
		for (const theme of ['light', 'dark']) {
			const { draft, target } = await seed(),
				{ c, p } = await page(width, theme, draft);
			const edit = ordinary(p),
				merge = finalEditor(p),
				before = await snapshot();
			const version = await p.locator('[name="version"]').inputValue();
			await rendered(edit, '원래 초안 본문');
			await rendered(merge, '기존 보관 정보와 초안');
			await edit
				.getByText('현재 저장본 기준 · 현재 입력을 미리 봅니다.', { exact: true })
				.waitFor();
			await merge
				.getByText('AI 통합 원안 기준 · 현재 입력을 미리 봅니다.', { exact: true })
				.waitFor();
			await view(edit, '편집');
			await body(p).fill(
				'## 현재 초안 입력\n\nOriginal Alias와 [[입력 중 제목]] [[입력 별칭]] [^same]\n\n| 항목 | 결과 |\n|---|---|\n| 검토 | 확인 |\n\n![그림](https://example.invalid/tracker)\n\n[^same]: 입력 중 각주'
			);
			await p.getByLabel('문서 제목', { exact: true }).fill('입력 중 제목');
			await p.getByLabel('별칭 (줄마다 하나)', { exact: true }).fill('입력 별칭');
			await rendered(edit, '현재 초안 입력');
			assert.equal(await edit.locator('.preview-title').innerText(), '입력 중 제목');
			assert.equal(await edit.locator('.wiki-content img').count(), 0);
			assert.equal(await publish(p).isDisabled(), true);
			assert.equal(await apply(p).isDisabled(), true);
			await p.getByText('저장된 초안과 비교', { exact: true }).click();
			await p
				.getByRole('article', { name: '저장된 초안 본문' })
				.getByText('원래 초안 본문', { exact: false })
				.waitFor();
			const duplicates = await p.evaluate(() => {
				const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
				return ids.filter((id, i) => ids.indexOf(id) !== i);
			});
			assert.deepEqual(duplicates, []);
			await edit.locator('.toc a').first().focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, `#draft-${draft.id}-edit-section-1`);
			await edit.locator('.footnote-ref a').focus();
			await p.keyboard.press('Enter');
			await edit.locator('.footnote-backlink').focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, `#draft-${draft.id}-edit-fnref-same-1`);
			assert.equal(
				await p.evaluate(() => document.activeElement.id),
				`draft-${draft.id}-edit-fnref-same-1`
			);

			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await screenshot(p, `ordinary-${width}-${theme}`);
			const editTable = edit.getByRole('region', { name: '표 1', exact: true });
			assert.equal(
				await editTable.getAttribute('aria-describedby'),
				`draft-${draft.id}-edit-table-1-hint`
			);
			await editTable.focus();
			assert.equal(
				await p.evaluate(() => document.activeElement.id),
				`draft-${draft.id}-edit-table-1`
			);
			assert.equal(await editTable.getByRole('columnheader').count(), 2);
			await verifyPreviewResizeFocus(p, edit);
			if (width < 1024) {
				await edit.getByRole('tab', { name: '미리보기', exact: true }).focus();
				await p.keyboard.press('ArrowLeft');
				assert.equal(await body(p).isVisible(), true);
			}
			await view(edit, '편집');
			await body(p).fill(source);
			await p.getByLabel('문서 제목', { exact: true }).fill(draft.title);
			await p.getByLabel('별칭 (줄마다 하나)', { exact: true }).fill('새 별칭');
			await rendered(edit, '원래 초안 본문');
			await confirm(p).check();
			await view(merge, '편집');
			const finalText =
				'## 최종 편집 입력\n\n기존 보관 정보 유지. [[Original Alias]] [[새 별칭]] [^same]\n\n### 확인 사항\n\n| 항목 | 결과 |\n|---|---|\n| 검토 | 확인 |\n\n[^same]: 최종 편집 각주';
			await finalBody(p).fill(finalText);
			await rendered(merge, '최종 편집 입력');
			assert.equal(await confirm(p).isChecked(), false);
			assert.equal(await p.locator('[name="version"]').inputValue(), version);
			assert.equal(await body(p).inputValue(), source);
			assert.deepEqual(await snapshot(), before);
			await merge.locator('.toc a').last().focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, `#draft-${draft.id}-merge-section-2`);
			await merge.locator('.footnote-ref a').focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, `#draft-${draft.id}-merge-fn-same`);
			await merge.locator('.footnote-backlink').focus();
			await p.keyboard.press('Enter');
			assert.equal(new URL(p.url()).hash, `#draft-${draft.id}-merge-fnref-same-1`);
			assert.equal(
				await p.evaluate(() => document.activeElement.id),
				`draft-${draft.id}-merge-fnref-same-1`
			);

			const mergeTable = merge.getByRole('region', { name: '표 1', exact: true });
			assert.equal(
				await mergeTable.getAttribute('aria-describedby'),
				`draft-${draft.id}-merge-table-1-hint`
			);
			await mergeTable.focus();
			assert.equal(
				await p.evaluate(() => document.activeElement.id),
				`draft-${draft.id}-merge-table-1`
			);
			assert.equal(await mergeTable.getByRole('cell').count(), 2);
			await verifyPreviewResizeFocus(p, merge);
			const html = await merge.locator('.wiki-content').innerHTML();
			await screenshot(p, `merge-${width}-${theme}`);
			await confirm(p).check();
			await apply(p).focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(base + '/wiki/fixed-target');
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${target.id}`)[0].content,
				finalText
			);
			assert.equal(
				await p.locator('.article-main .wiki-content').innerHTML(),
				html.replaceAll(`draft-${draft.id}-merge-`, '')
			);
			reports.push({
				width,
				theme,
				zoomEquivalent: width === 720 ? 200 : 100,
				currentInput: true,
				isolatedEditors: true,
				currentMergeMatchesPublication: true,
				keyboard: true,
				responsiveFocus: 'ordinary and final input, preview links and disappearing tabs'
			});
			await c.close();
		}
	const { draft } = await seed(),
		{ c, p } = await page(360, 'dark', draft),
		edit = ordinary(p);
	await rendered(edit, '원래 초안 본문');
	await view(edit, '편집');
	await body(p).fill('');
	await view(edit, '미리보기');
	await edit.getByText('본문을 입력하면 미리보기가 표시됩니다.', { exact: true }).waitFor();
	await p.getByRole('button', { name: '검토 내용 저장', exact: true }).click();
	assert.equal(await body(p).isVisible(), true);
	const before = await snapshot();
	let release, started;
	const gate = new Promise((resolve) => (release = resolve)),
		start = new Promise((resolve) => (started = resolve));
	await p.route('**/api/preview', async (route) => {
		if (route.request().postDataJSON().content !== '## 늦은 미리보기') return route.continue();
		const response = await route.fetch();
		started();
		await gate;
		await route.fulfill({ response }).catch(() => {});
	});
	await body(p).fill('## 늦은 미리보기');
	await start;
	await view(edit, '미리보기');
	await edit.getByText('현재 입력을 미리보기로 바꾸고 있습니다…', { exact: true }).waitFor();
	assert.equal(await edit.locator('.wiki-content').count(), 0);
	await screenshot(p, 'loading');
	await view(edit, '편집');
	await body(p).fill('## 최신 미리보기');
	await rendered(edit, '최신 미리보기');
	release();
	await p.waitForLoadState('networkidle');
	assert.equal(
		await edit.locator('.wiki-content').getByText('늦은 미리보기', { exact: true }).count(),
		0
	);
	await p.unroute('**/api/preview');
	await sql`ALTER TABLE redirects RENAME TO draft_preview_unavailable_aliases`;
	try {
		await view(edit, '편집');
		await body(p).fill('## 실패 후에도 유지하는 입력');
		await view(edit, '미리보기');
		await edit.getByRole('alert').waitFor();
		await p.waitForLoadState('networkidle', { timeout: 5000 });
		assert.equal(await body(p).inputValue(), '## 실패 후에도 유지하는 입력');
		await screenshot(p, 'error');
	} finally {
		await sql`ALTER TABLE draft_preview_unavailable_aliases RENAME TO redirects`;
	}
	await edit.getByRole('button', { name: '미리보기 다시 시도', exact: true }).click();
	await rendered(edit, '실패 후에도 유지하는 입력');
	assert.deepEqual(await snapshot(), before);
	await c.close();
	await sql`UPDATE documents SET content='다른 작성자의 대상 변경',updated_at=clock_timestamp() WHERE slug='fixed-target'`;
	const staleSnapshot = await snapshot();
	const stalePage = await page(768, 'dark', draft);
	await view(finalEditor(stalePage.p), '미리보기');
	await finalEditor(stalePage.p).getByRole('alert').waitFor();
	assert.equal(await apply(stalePage.p).isDisabled(), true);
	assert.deepEqual(await snapshot(), staleSnapshot);
	await stalePage.c.close();
	await sql`UPDATE drafts SET status='blocked',governance='{"passed":false,"regex":{"reasons":["본문 확인"]},"fields":[{"field":"content","label":"위키 본문"}]}' WHERE id=${draft.id}`;
	const protectedPage = await page(360, 'light', draft);
	await rendered(ordinary(protectedPage.p), '원래 초안 본문');
	await protectedPage.p.getByRole('link', { name: '위키 본문 수정하기', exact: true }).click();
	assert.equal(await body(protectedPage.p).isVisible(), true);
	assert.equal(await body(protectedPage.p).evaluate((el) => el === document.activeElement), true);
	await protectedPage.c.close();
	reports.push({
		empty: true,
		loading: true,
		staleResponsesIgnored: true,
		actualDatabaseFailure: true,
		retry: true,
		inputPreserved: true,
		protectedFieldCorrection: true,
		staleTargetFailsWithoutPendingRequests: true
	});
	assert.deepEqual(errors, []);
	assert.deepEqual(outbound, []);
	assert.equal(externalCalls, 0);
	await writeFile(
		output + '/draft-preview-results.json',
		JSON.stringify({ reports, errors, outbound, externalCalls }, null, 2)
	);
	console.log(JSON.stringify({ reports, errors, outbound, externalCalls, output }, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
