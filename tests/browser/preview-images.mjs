import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { draftRecoveryStore } from '../../src/lib/draft-recovery.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.IMAGE_PREVIEW_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-preview-images-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	base = 'http://127.0.0.1:4179';
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
	server: { host: '127.0.0.1', port: 4179, strictPort: true, watch: null },
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
const confirm = (p) => p.locator('[name="confirmMerge"]');
const publish = (p) => p.getByRole('button', { name: '검토 완료 · 문서 게시', exact: true });
const apply = (p) => p.getByRole('button', { name: '검토 완료 · 기존 문서에 통합', exact: true });
const imageHost = 'http://127.0.0.1:4178';
const source = [
	'## 저장된 초안',
	'원래 초안 본문 [[Original Alias]]',
	`![초안 도면](${imageHost}/draft.svg "도면 제목")`
].join('\n\n');
let retryFails = true,
	pendingGate = Promise.resolve();
const imageRequests = [];
const svg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="600" viewBox="0 0 1800 600"><rect width="1800" height="600" fill="#e5ecdf"/><rect x="60" y="70" width="1680" height="460" rx="18" fill="#fffaf2" stroke="#6d7d51" stroke-width="8"/><text x="120" y="245" font-family="sans-serif" font-size="88" fill="#27291f">Inspection diagram</text><path d="M130 360h650l160-80 160 80h530" fill="none" stroke="#ac571f" stroke-width="22"/></svg>';
const imageServer = createHttpServer(async (request, response) => {
	imageRequests.push(request.url);
	if (request.url.startsWith('/pending.svg')) await pendingGate;
	if (response.destroyed) return;
	const failed = request.url.startsWith('/retry.svg') && retryFails;
	response.writeHead(failed ? 404 : 200, {
		'content-type': failed ? 'text/plain' : 'image/svg+xml',
		'cache-control': 'no-store'
	});
	response.end(failed ? 'Synthetic unavailable image' : svg);
});
await new Promise((resolve, reject) => {
	imageServer.once('error', reject);
	imageServer.listen(4178, '127.0.0.1', resolve);
});

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
			content: source.replace('저장된 초안', '통합 원안').replace('/draft.svg', '/merge.svg'),
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
		const url = route.request().url();
		if (!url.startsWith(base + '/') && !url.startsWith(imageHost + '/')) {
			outbound.push(url);
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

const choice = (editor) =>
	editor.getByRole('checkbox', { name: '현재 미리보기의 이미지 표시', exact: true });
async function imagesReady(editor, count = 1) {
	await editor.locator('.wiki-content img').first().waitFor();
	const id = await editor.locator('.preview-panel').getAttribute('id');
	await editor.page().waitForFunction(
		({ id, count }) => {
			const images = [...document.getElementById(id).querySelectorAll('.wiki-content img')];
			return (
				images.length === count && images.every((image) => image.complete && image.naturalWidth > 0)
			);
		},
		{ id, count }
	);
}
async function choose(editor) {
	await view(editor, '미리보기');
	await choice(editor).focus();
	await editor.page().keyboard.press('Space');
	assert.equal(await choice(editor).isChecked(), true);
}
async function defaultReady(editor, heading) {
	await rendered(editor, heading);
	assert.equal(await choice(editor).isChecked(), false);
	assert.equal(await editor.locator('.wiki-content img').count(), 0);
}
const inputNames = [
	'id',
	'version',
	'title',
	'content',
	'aliases',
	'editor',
	'proposalId',
	'target',
	'finalContent',
	'mergeEditor'
];
async function inputs(p) {
	return Object.fromEntries(
		await Promise.all(
			inputNames.map(async (name) => [name, await p.locator(`[name="${name}"]`).inputValue()])
		)
	);
}
async function latestCopy(p) {
	return p.evaluate(
		(prefix) =>
			Object.keys(localStorage)
				.filter((key) => key.startsWith(prefix))
				.map((key) => JSON.parse(localStorage.getItem(key)))
				.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id))[0],
		draftRecoveryStore.prefix
	);
}
async function verifyRecovery(width, theme) {
	const { draft } = await seed(),
		{ c, p } = await page(width, theme, draft);
	// Only this fixture's intentional reloads accept the unsaved-input warning.
	p.removeAllListeners('dialog');
	p.on('dialog', (dialog) => dialog.accept());
	const before = await snapshot(),
		original = await inputs(p);
	const changed = {
		...original,
		title: '복구할 초안 제목',
		content: source.replace('저장된 초안', '복구할 일반 본문'),
		aliases: '복구 별칭\n쉼표, 별칭',
		editor: 'Editor-77',
		finalContent: original.finalContent.replace('통합 원안', '복구할 최종 본문'),
		mergeEditor: 'Editor-88'
	};
	await view(ordinary(p), '편집');
	await view(finalEditor(p), '편집');
	for (const name of ['title', 'content', 'aliases', 'editor', 'finalContent', 'mergeEditor'])
		await p.locator(`[name="${name}"]`).fill(changed[name]);
	await p
		.getByRole('checkbox', {
			name: '민감 정보가 없는 입력을 이 브라우저에 24시간 임시 보관',
			exact: true
		})
		.check();
	for (const phase of ['ordinary-and-final', 'final-review']) {
		if (phase === 'final-review') {
			await view(ordinary(p), '편집');
			for (const name of ['title', 'content', 'aliases', 'editor']) {
				changed[name] = original[name];
				await p.locator(`[name="${name}"]`).fill(original[name]);
			}
		}
		await choose(ordinary(p));
		await imagesReady(ordinary(p));
		await choose(finalEditor(p));
		await imagesReady(finalEditor(p));
		await p.locator('[name="confirmDelete"]').check();
		await p.locator('[name="confirmResetMerge"]').check();
		if (phase === 'final-review') {
			await confirm(p).focus();
			await p.keyboard.press('Space');
			assert.equal(await confirm(p).isChecked(), true);
			assert.equal(await apply(p).isEnabled(), true);
		}
		await p.waitForFunction(
			({ prefix, values }) =>
				Object.keys(localStorage)
					.filter((key) => key.startsWith(prefix))
					.some((key) => {
						const stored = JSON.parse(localStorage.getItem(key)).values;
						return Object.entries(values).every(([name, value]) => stored[name] === value);
					}),
			{ prefix: draftRecoveryStore.prefix, values: changed }
		);
		// The persisted values exclude image display and every approval, even when checked.
		assert.deepEqual((await latestCopy(p)).values, { ...changed, sourceName: '' });
		const requests = imageRequests.length;
		await p.reload({ waitUntil: 'networkidle' });
		await defaultReady(ordinary(p), '저장된 초안');
		await defaultReady(finalEditor(p), '통합 원안');
		assert.deepEqual(await inputs(p), original);
		assert.equal(imageRequests.length, requests);
		const restore = p.getByRole('button', { name: '이 입력 복구', exact: true }).first();
		await restore.focus();
		await p.keyboard.press('Enter');
		assert.deepEqual(await inputs(p), changed);
		await defaultReady(ordinary(p), phase === 'final-review' ? '저장된 초안' : '복구할 일반 본문');
		await defaultReady(finalEditor(p), '복구할 최종 본문');
		for (const name of ['confirmDelete', 'confirmResetMerge', 'confirmMerge'])
			assert.equal(await p.locator(`[name="${name}"]`).isChecked(), false);
		assert.equal(await apply(p).isDisabled(), phase === 'ordinary-and-final');
		assert.equal(await publish(p).isDisabled(), true);
		if (phase === 'final-review') {
			const response = p.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().includes('?/applyMerge')
			);
			await apply(p).click();
			assert.equal((await (await response).json()).status, 400);
			await p
				.getByText('최종 본문과 상충 내용을 검토했다는 확인 항목을 선택해 주세요.', { exact: true })
				.waitFor();
			await p.locator('.wiki-form[aria-busy="true"]').waitFor({ state: 'detached' });
			assert.deepEqual(await inputs(p), changed);
			await defaultReady(ordinary(p), '저장된 초안');
			await defaultReady(finalEditor(p), '복구할 최종 본문');
			assert.equal(await confirm(p).isChecked(), false);
		}
		assert.equal(imageRequests.length, requests);
		assert.deepEqual(await snapshot(), before);
		assert.deepEqual((await latestCopy(p)).values, { ...changed, sourceName: '' });
		assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	}
	await screenshot(p, `recovery-${width}-${theme}`);
	await c.close();
	reports.push({
		width,
		theme,
		recovery:
			'ordinary/final input and original versions restored; image choice and approvals excluded; no automatic image requests or database writes'
	});
}
try {
	for (const width of [360, 768, 1440, 720])
		for (const theme of ['light', 'dark']) await verifyRecovery(width, theme);
	for (const width of [360, 768, 1440, 720])
		for (const theme of ['light', 'dark']) {
			const startRequests = imageRequests.length;
			let { draft } = await seed();
			let { c, p } = await page(width, theme, draft);
			let edit = ordinary(p),
				merge = finalEditor(p);
			const before = await snapshot();
			await defaultReady(edit, '저장된 초안');
			await defaultReady(merge, '통합 원안');
			assert.equal(imageRequests.length, startRequests);
			await choose(edit);
			await imagesReady(edit);
			assert.equal(await choice(merge).isChecked(), false);
			assert.equal(await merge.locator('.wiki-content img').count(), 0);
			assert.equal(await confirm(p).isChecked(), false);
			assert.equal(await publish(p).isDisabled(), false);
			const html = await edit.locator('.wiki-content').innerHTML();
			assert.equal(await edit.locator('img').getAttribute('alt'), '초안 도면');
			assert.equal(await edit.locator('img').getAttribute('title'), '도면 제목');
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
				true
			);
			assert.deepEqual(await snapshot(), before);
			await screenshot(p, `ordinary-${width}-${theme}`);
			await publish(p).click();
			await p.waitForURL(/\/wiki\//);
			await p.locator('.article-main .wiki-content img').waitFor();
			assert.equal(
				await p.locator('.article-main .wiki-content').innerHTML(),
				html.replaceAll(`draft-${draft.id}-edit-`, '')
			);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE title=${draft.title}`)[0].content,
				source
			);
			await c.close();

			const seeded = await seed();
			draft = seeded.draft;
			({ c, p } = await page(width, theme, draft));
			edit = ordinary(p);
			merge = finalEditor(p);
			const mergeBefore = await snapshot(),
				mergeRequests = imageRequests.length;
			await defaultReady(edit, '저장된 초안');
			await defaultReady(merge, '통합 원안');
			assert.equal(imageRequests.length, mergeRequests);
			await choose(merge);
			await imagesReady(merge);
			assert.equal(await choice(edit).isChecked(), false);
			assert.equal(await edit.locator('.wiki-content img').count(), 0);
			const mergeHtml = await merge.locator('.wiki-content').innerHTML();
			assert.deepEqual(await snapshot(), mergeBefore);
			await screenshot(p, `merge-${width}-${theme}`);
			await confirm(p).check();
			await apply(p).click();
			await p.waitForURL(base + '/wiki/fixed-target');
			assert.equal(
				await p.locator('.article-main .wiki-content').innerHTML(),
				mergeHtml.replaceAll(`draft-${draft.id}-merge-`, '')
			);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${seeded.target.id}`)[0].content,
				seeded.proposal.content
			);
			await c.close();
			reports.push({
				width,
				theme,
				zoomEquivalent: width === 720 ? 200 : 100,
				defaultRequests: 0,
				keyboardOptIn: true,
				isolatedEditors: true,
				actualPublicationAndMergeImagesMatch: true
			});
		}
	const { draft } = await seed();
	const { c, p } = await page(1440, 'light', draft),
		edit = ordinary(p),
		merge = finalEditor(p);
	const before = await snapshot();
	await defaultReady(edit, '저장된 초안');
	await defaultReady(merge, '통합 원안');
	await choose(edit);
	await imagesReady(edit);
	let count = imageRequests.length;
	const changed = source.replace('/draft.svg', '/changed.svg');
	await body(p).fill(changed);
	await defaultReady(edit, '저장된 초안');
	await body(p).fill(source);
	await defaultReady(edit, '저장된 초안');
	assert.equal(imageRequests.length, count);
	for (const [label, original] of [
		['문서 제목', draft.title],
		['별칭 (줄마다 하나)', '새 별칭']
	]) {
		await choose(edit);
		await imagesReady(edit);
		count = imageRequests.length;
		const field = p.getByLabel(label, { exact: true });
		await field.fill(original + ' 수정');
		await defaultReady(edit, '저장된 초안');
		await field.fill(original);
		await defaultReady(edit, '저장된 초안');
		assert.equal(imageRequests.length, count);
	}
	assert.deepEqual(await snapshot(), before);
	reports.push({
		reset: 'content, title and aliases revoke the choice, including after reverting the input'
	});

	// Hold a genuine image-bearing API response after transport cancellation is disabled.
	await p.evaluate(() => {
		const original = window.fetch;
		window.fetch = (url, options) =>
			original(url, String(url) === '/api/preview' ? { ...options, signal: undefined } : options);
	});
	let release, reached;
	const gate = new Promise((resolve) => (release = resolve)),
		started = new Promise((resolve) => (reached = resolve));
	await p.route('**/api/preview', async (route) => {
		if (!route.request().postDataJSON().showImages) return route.continue();
		const response = await route.fetch();
		reached();
		await gate;
		await route.fulfill({ response }).catch(() => {});
	});
	count = imageRequests.length;
	await choose(edit);
	await started;
	await choice(edit).uncheck();
	await defaultReady(edit, '저장된 초안');
	release();
	await p.waitForLoadState('networkidle');
	assert.equal(imageRequests.length, count);
	assert.equal(await edit.locator('.wiki-content img').count(), 0);
	await p.unroute('**/api/preview');
	reports.push({
		staleResponse: 'revoked image HTML cannot start an image request even when abort is ineffective'
	});

	let releaseImage;
	pendingGate = new Promise((resolve) => (releaseImage = resolve));
	const pendingContent = `## 이미지 상태\n\n![대기 도면](${imageHost}/pending.svg)\n\n![재시도 도면](${imageHost}/retry.svg)`;
	await body(p).fill(pendingContent);
	await defaultReady(edit, '이미지 상태');
	await choose(edit);
	await edit.getByText('이미지 1개를 불러오고 있습니다…', { exact: true }).waitFor();
	await edit
		.getByText('이미지 1개를 불러오지 못했습니다. 본문의 이미지 주소를 확인해 주세요.', {
			exact: true
		})
		.waitFor();
	await screenshot(p, 'image-loading-and-failure');
	releaseImage();
	await edit
		.getByText('이미지 1개를 불러오고 있습니다…', { exact: true })
		.waitFor({ state: 'hidden' });
	retryFails = false;
	await edit.getByRole('button', { name: '이미지 다시 불러오기', exact: true }).click();
	await imagesReady(edit, 2);
	assert.equal(await edit.getByRole('alert').count(), 0);
	assert.equal(await body(p).inputValue(), pendingContent);
	assert.deepEqual(await snapshot(), before);
	await screenshot(p, 'image-recovered');
	count = imageRequests.length;
	await body(p).fill('');
	await view(edit, '미리보기');
	await edit.getByText('본문을 입력하면 미리보기가 표시됩니다.', { exact: true }).waitFor();
	assert.equal(await choice(edit).isChecked(), false);
	assert.equal(await edit.locator('img').count(), 0);
	assert.equal(await edit.getByRole('alert').count(), 0);
	assert.equal(imageRequests.length, count);
	reports.push({
		imageStates:
			'actual pending and failed local HTTP images, successful retry, empty input and unchanged database'
	});

	await body(p).fill(source);
	await defaultReady(edit, '저장된 초안');
	await choose(edit);
	await imagesReady(edit);
	const [other] =
		await sql`INSERT INTO drafts(title,slug,content,governance) VALUES('다른 초안','other-preview',${source.replace('/draft.svg', '/other.svg')},'{"passed":true}') RETURNING id`;
	const withOther = await snapshot();
	count = imageRequests.length;
	await p.goto(base + '/drafts?open=' + other.id, { waitUntil: 'networkidle' });
	await defaultReady(ordinary(p), '저장된 초안');
	assert.equal(imageRequests.length, count);
	assert.deepEqual(await snapshot(), withOther);
	await c.close();
	reports.push({
		scope: 'opening another draft resets image choice without image requests or data changes'
	});
	assert.deepEqual(errors, []);
	assert.deepEqual(outbound, []);
	assert.equal(externalCalls, 0);
	await writeFile(
		output + '/image-preview-results.json',
		JSON.stringify(
			{
				reports,
				errors,
				outbound,
				externalCalls,
				controlledLocalImageRequests: imageRequests.length
			},
			null,
			2
		)
	);
	console.log(
		JSON.stringify(
			{
				reports,
				errors,
				outbound,
				externalCalls,
				controlledLocalImageRequests: imageRequests.length,
				output
			},
			null,
			2
		)
	);
} finally {
	await browser.close();
	imageServer.closeAllConnections();
	await new Promise((resolve) => imageServer.close(resolve));
	await state.closeDatabase();
	await server.close();
}
