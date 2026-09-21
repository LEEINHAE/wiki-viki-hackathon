import { openMainMenu } from './helpers/navigation.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { workbookFile } from '../fixtures/office.js';
import { fineTopics } from '../fixtures/fine-topics.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.UPLOAD_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-xlsx-')));
const fixture = root + '/tests/fixtures/governance-database.js';
const base = 'http://127.0.0.1:4192';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
let generated = {
	documents: [
		{
			title: '인계 노트',
			sections: [{ heading: '안내', content: '다음 근무자에게 작업 상태를 전하는 예시 기록' }],
			aliases: [],
			suggestedLinks: []
		},
		{
			title: '공용 장비 점검표',
			sections: [{ heading: '안내', content: '장비 수량 & 위치를 확인하는 예시 양식' }],
			aliases: [],
			suggestedLinks: []
		}
	]
};
const originalFetch = globalThis.fetch;
let gate = null;
let calls = [];
let externalAttempts = 0;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (url === 'https://api.openai.com/v1/responses') {
		const request = JSON.parse(args[1].body);
		calls.push(request);
		if (gate) await gate;
		const value =
			request.text?.format?.name === 'wiki_documents'
				? {
						documents: generated.documents.filter((document) =>
							JSON.parse(request.input).topics.some((topic) => topic.title === document.title)
						)
					}
				: request.text?.format?.name === 'wiki_document_topics'
					? { topics: generated.documents.map(({ title }) => ({ title, scope: title })) }
					: { passed: true, reasons: [] };
		return Response.json({
			object: 'response',
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: JSON.stringify(value) }]
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
	server: { host: '127.0.0.1', port: 4192, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-xlsx-browser',
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
	reports = [];
async function workbook(options) {
	const file = await workbookFile(options);
	return {
		name: file.name,
		mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		buffer: Buffer.from(await file.arrayBuffer())
	};
}
const valid = await workbook();
async function open(p) {
	await openMainMenu(p);
	const link = p.getByRole('link', { name: 'AI 위키파이어', exact: true });
	await link.focus();
	await p.keyboard.press('Enter');
	await p.getByRole('dialog', { name: 'AI 위키파이어', exact: true }).waitFor();
}
async function submit(p, dialog) {
	const response = p.waitForResponse(
		(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
	);
	await dialog.getByRole('button', { name: '위키 초안 만들기', exact: true }).click();
	return response;
}
async function shot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			await state.clearDatabase();
			const withKey = !(width === 360 && theme === 'dark');
			state.env.OPENAI_API_KEY = withKey ? 'test-only-key' : '';
			calls = [];
			const context = await browser.newContext({
				viewport: { width, height: 850 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			const p = await context.newPage();
			p.on('pageerror', (e) => pageErrors.push(e.message));
			await p.goto(base + '/', { waitUntil: 'networkidle' });
			await open(p);
			const dialog = p.getByRole('dialog', { name: 'AI 위키파이어', exact: true });
			const input = dialog.getByLabel('업로드 파일', { exact: true });
			const create = dialog.getByRole('button', { name: '위키 초안 만들기', exact: true });
			assert.equal(await create.isDisabled(), true);
			await shot(p, `empty-${width}-${theme}`);
			// Extraction errors must leave the real dialog and selected file intact.
			await input.setInputFiles({
				...valid,
				name: 'broken.xlsx',
				buffer: Buffer.from('invalid archive')
			});
			assert.equal((await submit(p, dialog)).status(), 422);
			await dialog.getByRole('alert').filter({ hasText: '파일을 읽을 수 없습니다.' }).waitFor();
			assert.equal(await dialog.getByRole('button', { name: /broken.xlsx/ }).count(), 1);
			assert.equal(calls.length, 0);
			assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 0);
			await p.keyboard.press('Escape');
			await dialog.waitFor({ state: 'hidden' });
			await open(p);
			await dialog.getByRole('alert').filter({ hasText: '파일을 읽을 수 없습니다.' }).waitFor();
			assert.equal(await dialog.getByRole('button', { name: /broken.xlsx/ }).count(), 1);
			await shot(p, `error-${width}-${theme}`);
			// Non-JSON / malformed responses must not crash the result view or clear the file.
			await input.setInputFiles(valid);
			for (const response of [
				{
					status: 502,
					contentType: 'text/html',
					body: '<html>internal proxy error</html>',
					message: '초안 생성 결과를 확인하지 못했습니다.'
				},
				{
					status: 200,
					contentType: 'application/json',
					body: '{"count":1,"drafts":[null]}',
					message: '초안 생성 결과를 확인하지 못했습니다.'
				},
				{
					status: 504,
					contentType: 'application/json',
					body: JSON.stringify({
						message:
							'AI 초안 생성 시간이 초과되었습니다. 초안은 저장하지 않았습니다. 잠시 후 다시 시도해 주세요.'
					}),
					message: 'AI 초안 생성 시간이 초과되었습니다.'
				}
			]) {
				const { message, ...payload } = response;
				await p.route('**/api/wikify', (route) => route.fulfill(payload), { times: 1 });
				await submit(p, dialog);
				await dialog.getByRole('alert').filter({ hasText: message }).waitFor();
				assert.equal(await input.evaluate((el) => el.files.length), 1);
				assert.equal(await create.isEnabled(), true);
			}
			let release;
			if (withKey) gate = new Promise((r) => (release = r));
			const pending = submit(p, dialog);
			if (withKey) {
				await dialog.getByText('문서를 읽고 초안을 만들고 있습니다…', { exact: true }).waitFor();
				assert.equal(
					await dialog.getByRole('button', { name: '초안 생성 중…', exact: true }).isDisabled(),
					true
				);
				// Only the body scrolls, so errors / long results cannot hide the close control.
				await dialog.locator('.dialog-inner').evaluate((el) => (el.scrollTop = el.scrollHeight));
				const close = dialog.getByRole('button', { name: '위키파이어 닫기', exact: true });
				assert.equal(
					await close.evaluate((el) => {
						const r = el.getBoundingClientRect();
						return r.top >= 0 && r.bottom <= innerHeight;
					}),
					true
				);
				assert.equal(
					await p.evaluate(() => getComputedStyle(document.documentElement).overflow),
					'hidden'
				);
				await shot(p, `loading-${width}-${theme}`);
				await close.click();
				await dialog.waitFor({ state: 'hidden' });
				await open(p);
				await dialog.getByText('문서를 읽고 초안을 만들고 있습니다…', { exact: true }).waitFor();
				assert.equal(await input.evaluate((el) => el.files.length), 1);
				await p.mouse.click(2, 2);
				await dialog.waitFor({ state: 'hidden' });
				release();
				gate = null;
			}
			assert.equal((await pending).status(), 201);
			if (withKey) await open(p);
			const count = withKey ? 2 : 1;
			await dialog
				.getByRole('heading', { name: `${count}개의 초안이 준비됐어요.`, exact: true })
				.waitFor();
			await p.waitForLoadState('networkidle');
			assert.equal(await dialog.isVisible(), true);
			assert.equal(calls.length, withKey ? 3 : 0);
			const drafts = await sql`SELECT * FROM drafts ORDER BY id`;
			assert.equal(drafts.length, count);
			for (const draft of drafts) {
				assert.equal(draft.source_name, valid.name);
				assert.equal(draft.status, 'review');
			}
			if (withKey) {
				const sent = JSON.stringify(calls[0]);
				assert.ok(
					sent.includes('업무 용어') && sent.includes('점검표') && sent.includes('2024-01-01')
				);
				assert.deepEqual(
					drafts.map((d) => d.title),
					generated.documents.map((d) => d.title)
				);
			} else {
				assert.ok(drafts[0].content.includes('시트: 업무 용어'));
				assert.ok(drafts[0].content.includes('시트: 점검표'));
				await dialog
					.getByText('AI가 연결되지 않아 원문을 기본 초안 하나로 준비했습니다.', { exact: false })
					.waitFor();
			}
			await p.keyboard.press('Escape');
			await dialog.waitFor({ state: 'hidden' });
			await open(p);
			await dialog
				.getByRole('heading', { name: `${count}개의 초안이 준비됐어요.`, exact: true })
				.waitFor();
			assert.equal(await dialog.locator('.generated-draft').count(), count);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `success-${width}-${theme}`);
			await dialog.locator('.generated-draft').first().focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(/\/drafts\?open=/);
			await dialog.waitFor({ state: 'hidden' });
			assert.equal(
				await p.getByLabel('위키 본문', { exact: true }).inputValue(),
				drafts[0].content
			);
			reports.push({
				width,
				theme,
				withKey,
				drafts: count,
				errorAndRetry: true,
				closeReopen: true,
				realDatabase: true
			});
			await context.close();
		}
	// The client deadline does not prove server cancellation: retain the file and link to drafts.
	await state.clearDatabase();
	state.env.OPENAI_API_KEY = '';
	const timeoutPage = await browser.newPage({ viewport: { width: 360, height: 850 } });
	timeoutPage.on('pageerror', (e) => pageErrors.push(e.message));
	await timeoutPage.goto(base + '/', { waitUntil: 'networkidle' });
	await open(timeoutPage);
	const timeoutDialog = timeoutPage.getByRole('dialog', { name: 'AI 위키파이어', exact: true });
	await timeoutDialog.getByLabel('업로드 파일', { exact: true }).setInputFiles(valid);
	await timeoutPage.clock.install();
	await timeoutPage.route('**/api/wikify', () => {});
	await timeoutDialog.getByRole('button', { name: '위키 초안 만들기', exact: true }).click();
	await timeoutDialog.getByText('문서를 읽고 초안을 만들고 있습니다…', { exact: true }).waitFor();
	await timeoutPage.clock.fastForward(120001);
	await timeoutDialog.getByRole('alert').filter({ hasText: '처리가 지연되고 있습니다.' }).waitFor();
	assert.equal(
		await timeoutDialog.getByRole('link', { name: '초안 검토 목록 확인하기 →' }).count(),
		1
	);
	assert.equal(
		await timeoutDialog.getByRole('button', { name: /office-verification.xlsx/ }).count(),
		1
	);
	await timeoutPage.unroute('**/api/wikify');
	// A successful upload remains visible even if reloading the underlying page fails.
	let failedRefreshes = 0;
	await timeoutPage.route('**/__data.json*', (route) => {
		failedRefreshes++;
		return route.fulfill({ status: 503, contentType: 'text/html', body: 'proxy unavailable' });
	});
	assert.equal((await submit(timeoutPage, timeoutDialog)).status(), 201);
	await timeoutDialog
		.getByRole('heading', { name: '1개의 초안이 준비됐어요.', exact: true })
		.waitFor();
	await timeoutPage.waitForLoadState('networkidle');
	assert.ok(failedRefreshes > 0);
	assert.equal(await timeoutDialog.isVisible(), true);
	assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 1);
	await timeoutPage.close();
	reports.push({
		timeout: 'selected file and results link retained; retry saved once',
		refreshFailure: 'confirmed success retained'
	});
	// Empty workbook and unsupported extension use the same independent-page form.
	const p = await browser.newPage();
	p.on('pageerror', (e) => pageErrors.push(e.message));
	await p.goto(base + '/wikify', { waitUntil: 'networkidle' });
	const form = p.locator('.upload-page');
	await form
		.getByLabel('업로드 파일', { exact: true })
		.setInputFiles({ ...valid, name: 'legacy.xls' });
	await form.getByRole('alert').filter({ hasText: '구형 .xls' }).waitFor();
	assert.equal(
		await form.getByRole('button', { name: '위키 초안 만들기', exact: true }).isDisabled(),
		true
	);
	const before = calls.length;
	await form
		.getByLabel('업로드 파일', { exact: true })
		.setInputFiles(await workbook({ empty: true }));
	assert.equal((await submit(p, form)).status(), 422);
	await form.getByRole('alert').filter({ hasText: '텍스트를 추출할 수 없습니다.' }).waitFor();
	assert.equal(calls.length, before);
	await p.close();
	// More than eight semantic topics must survive parsing, generation, DB storage and the modal.
	generated = {
		documents: [
			...fineTopics,
			...Array.from({ length: 20 }, (_, i) => ({
				title: `교육용 보조센서 ${i + 1} 확인`,
				sections: [
					{
						heading: '가상 실습',
						content: `가상 센서 ${i + 1}의 표시는 ${i + 2} 단위입니다. 해당 값을 실습 기록에 옮깁니다.`
					}
				],
				aliases: [],
				suggestedLinks: []
			}))
		]
	};
	const archive = await JSZip.loadAsync(valid.buffer);
	const escape = (text) =>
		text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	archive.file(
		'xl/worksheets/sheet2.xml',
		`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${generated.documents.map((document, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${escape(document.title)}</t></is></c><c r="B${i + 1}" t="inlineStr"><is><t>${escape(document.sections[0].content)}</t></is></c></row>`).join('')}</sheetData></worksheet>`
	);
	archive.file(
		'xl/worksheets/sheet1.xml',
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
	);
	const fineFile = {
		...valid,
		name: '가상-교육-세부점검.xlsx',
		buffer: await archive.generateAsync({ type: 'nodebuffer' })
	};
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			await state.clearDatabase();
			state.env.OPENAI_API_KEY = 'test-only-key';
			calls = [];
			const context = await browser.newContext({
				viewport: { width, height: 850 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			const p = await context.newPage();
			p.on('pageerror', (error) => pageErrors.push(error.message));
			await p.goto(base + '/', { waitUntil: 'networkidle' });
			await open(p);
			const dialog = p.getByRole('dialog', { name: 'AI 위키파이어', exact: true });
			await dialog.getByLabel('업로드 파일', { exact: true }).setInputFiles(fineFile);
			await dialog.getByText(/최대 32개의 세부 초안/).waitFor();
			assert.equal((await submit(p, dialog)).status(), 201);
			await dialog
				.getByRole('heading', { name: '32개의 초안이 준비됐어요.', exact: true })
				.waitFor();
			assert.equal(calls.length, 6);
			assert.ok(calls[0].input.includes('교육용 보조센서 20 확인'));
			assert.equal(await dialog.locator('.generated-draft').count(), 32);
			const rows = await sql`SELECT * FROM drafts ORDER BY id`;
			assert.deepEqual(
				rows.map((draft) => draft.title),
				generated.documents.map((document) => document.title)
			);
			assert.ok(
				rows.every((draft) => draft.source_name === fineFile.name && draft.status === 'review')
			);
			await shot(p, `fine-success-${width}-${theme}`);
			await dialog.locator('.generated-draft').last().focus();
			assert.equal(
				await dialog
					.locator('.generated-draft')
					.last()
					.evaluate((el) => {
						const box = el.getBoundingClientRect();
						return box.top >= 0 && box.bottom <= innerHeight;
					}),
				true
			);
			assert.equal(
				await dialog
					.getByRole('button', { name: '위키파이어 닫기', exact: true })
					.evaluate((el) => {
						const box = el.getBoundingClientRect();
						return el.contains(
							document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
						);
					}),
				true
			);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `fine-last-${width}-${theme}`);
			await dialog.getByRole('button', { name: '위키파이어 닫기', exact: true }).click();
			await dialog.waitFor({ state: 'hidden' });
			await open(p);
			assert.equal(await dialog.locator('.generated-draft').count(), 32);
			await dialog.locator('.generated-draft').last().focus();
			await p.keyboard.press('Enter');
			await p.waitForURL(base + '/drafts?open=' + rows.at(-1).id);
			assert.equal(
				await p.getByLabel('위키 본문', { exact: true }).inputValue(),
				rows.at(-1).content
			);
			await p.getByRole('link', { name: '← 목록으로', exact: true }).click();
			await p.waitForURL(base + '/drafts');
			assert.equal(await p.locator('.review-row').count(), 20);
			await p.getByRole('link', { name: '다음 →', exact: true }).click();
			await p.waitForURL(/page=2/);
			assert.equal(await p.locator('.review-row').count(), 12);
			reports.push({
				width,
				theme,
				fineTopics: 32,
				generatedBatches: 4,
				finalDraftAccessible: true,
				reviewPages: [20, 12]
			});
			await context.close();
		}
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/xlsx-browser-results.json',
		JSON.stringify({ reports, pageErrors, externalAttempts, mockedAI: true }, null, 2)
	);
	console.log(
		JSON.stringify({ reports, pageErrors, externalAttempts, mockedAI: true, output }, null, 2)
	);
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
