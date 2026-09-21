import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { presentationFile } from '../fixtures/office.js';
import { blockedTopicCases } from '../fixtures/governance-topics.js';
import { openMainMenu } from './helpers/navigation.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.RELAXED_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-relaxed-upload-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	base = 'http://127.0.0.1:4190';
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const source =
	'대외비 인사정보 급여 업무 안내: 홍길동, 사번: demo42, test.user@example.invalid, 010-0000-0000';
let generated = {
	documents: [
		{
			title: '급여 업무 안내',
			sections: [{ heading: '담당자', content: source }],
			aliases: ['인사정보'],
			suggestedLinks: []
		}
	]
};
const originalFetch = globalThis.fetch;
let externalAttempts = 0,
	calls = [],
	collapseTopics = false,
	plannedTopics = null,
	gate = null;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (url === 'https://api.openai.com/v1/responses') {
		const request = JSON.parse(args[1].body);
		calls.push(request);
		if (gate) await gate;
		const value =
			request.text?.format?.name === 'wiki_documents'
				? collapseTopics
					? { documents: generated.documents.slice(0, 1) }
					: generated
				: request.text?.format?.name === 'wiki_document_topics'
					? {
							topics:
								plannedTopics ||
								generated.documents.map(({ title }) => ({
									title,
									scope: '급여 업무 담당자 안내'
								}))
						}
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
	server: { host: '127.0.0.1', port: 4190, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-relaxed-upload-browser',
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
const browser = await chromium.launch({ channel: 'chrome', headless: true }),
	pageErrors = [],
	reports = [];
async function file(text = source, name = 'confidential-인사정보-급여.pptx') {
	const original = await presentationFile(),
		zip = await JSZip.loadAsync(await original.arrayBuffer()),
		part = 'ppt/slides/slide10.xml';
	zip.file(part, (await zip.file(part).async('string')).replace('인계 ', text + ' '));
	return {
		name,
		mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	};
}
async function shot(p, name) {
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
}
try {
	for (const [withKey, width, theme] of [
		[false, 360, 'dark'],
		[true, 1440, 'light']
	]) {
		await state.clearDatabase();
		state.env.OPENAI_API_KEY = withKey ? 'test-only-key' : '';
		calls = [];
		const context = await browser.newContext({
			viewport: { width, height: 950 },
			reducedMotion: 'reduce'
		});
		await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
		const p = await context.newPage();
		p.on('pageerror', (e) => pageErrors.push(e.message));
		await p.goto(base + '/wikify', { waitUntil: 'networkidle' });
		assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
		const create = p.getByRole('button', { name: '위키 초안 만들기', exact: true });
		assert.equal(await create.isDisabled(), true);
		await p.getByLabel('업로드 파일', { exact: true }).setInputFiles(await file());
		let release;
		if (withKey) gate = new Promise((r) => (release = r));
		const response = p.waitForResponse(
			(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
		);
		await create.focus();
		await p.keyboard.press('Enter');
		if (withKey) {
			await p.getByText('문서를 읽고 초안을 만들고 있습니다…', { exact: true }).waitFor();
			assert.equal(
				await p.getByRole('button', { name: '초안 생성 중…', exact: true }).isDisabled(),
				true
			);
			await shot(p, 'loading-' + width);
			release();
			gate = null;
		}
		assert.equal((await response).status(), 201);
		await p.getByRole('heading', { name: '1개의 초안이 준비됐어요.', exact: true }).waitFor();
		assert.equal(
			await p
				.getByText(
					'AI 의미 기반 검사는 실행되지 않았습니다. 게시 전에 내용을 직접 확인해 주세요.',
					{ exact: true }
				)
				.count(),
			withKey ? 0 : 1
		);
		assert.equal(
			await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
			true
		);
		await shot(p, 'uploaded-' + width + '-' + theme);
		const [draft] = await sql`SELECT * FROM drafts`;
		assert.equal(draft.status, 'review');
		assert.ok(draft.content.includes(source));
		assert.equal(draft.source_name, 'confidential-인사정보-급여.pptx');
		assert.equal(calls.length, withKey ? 3 : 0);
		await p.locator('.generated-draft').click();
		await p.getByLabel('위키 본문', { exact: true }).waitFor();
		assert.equal(
			await p
				.getByText('AI 의미 기반 검사는 실행되지 않았습니다. 내용을 직접 확인해 주세요.', {
					exact: true
				})
				.count(),
			withKey ? 0 : 1
		);
		assert.ok((await p.getByLabel('위키 본문', { exact: true }).inputValue()).includes(source));
		const publish = p.getByRole('button', { name: '검토 완료 · 문서 게시', exact: true });
		assert.equal(await publish.isEnabled(), true);
		await publish.focus();
		await p.keyboard.press('Enter');
		await p.waitForURL(/\/wiki\//);
		const [doc] = await sql`SELECT * FROM documents`;
		assert.ok(doc.content.includes(source));
		assert.equal(
			(await sql`SELECT status FROM drafts WHERE id=${draft.id}`)[0].status,
			'published'
		);
		await shot(p, 'published-' + width + '-' + theme);
		await p.goto(base + '/wikify', { waitUntil: 'networkidle' });
		await p
			.getByLabel('업로드 파일', { exact: true })
			.setInputFiles(await file('password=NotARealSecret42!', '실제-차단-검증.pptx'));
		const before = calls.length,
			blocked = p.waitForResponse(
				(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
			);
		await create.click();
		assert.equal((await blocked).status(), 422);
		await p.getByRole('alert').filter({ hasText: '주민등록번호·비밀번호·인증 키' }).waitFor();
		assert.equal(calls.length, before);
		assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 1);
		assert.equal(await p.getByRole('button', { name: /실제-차단-검증.pptx/ }).count(), 1);
		await shot(p, 'blocked-' + width + '-' + theme);
		await context.close();
		reports.push({
			withKey,
			width,
			theme,
			upload: '201 with original contact/HR content',
			publication: '303 and actual DB content preserved',
			credentials: '422 before AI; chosen file retained'
		});
	}
	generated = {
		documents: [
			{
				title: '교대 인계',
				sections: [
					{ heading: '전달', content: '설비 점검 후 다음 근무자에게 운전 상태를 전달합니다.' }
				],
				suggestedLinks: ['설비 점검'],
				aliases: ['근무 인계']
			},
			{
				title: '설비 점검',
				sections: [
					{ heading: '확인', content: '압력계를 확인하고 이상이 있으면 이상 보고를 진행합니다.' }
				],
				suggestedLinks: ['이상 보고'],
				aliases: []
			},
			{
				title: '이상 보고',
				sections: [
					{ heading: '보고', content: '설비 점검 중 발견한 이상은 당직자에게 보고합니다.' }
				],
				suggestedLinks: ['설비 점검'],
				aliases: []
			}
		]
	};
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			await state.clearDatabase();
			state.env.OPENAI_API_KEY = 'test-only-key';
			const context = await browser.newContext({
				viewport: { width, height: 950 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			const p = await context.newPage();
			p.on('pageerror', (error) => pageErrors.push(error.message));
			await p.goto(base + '/wikify', { waitUntil: 'networkidle' });
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			const create = p.getByRole('button', { name: '위키 초안 만들기', exact: true });
			assert.equal(await create.isDisabled(), true);
			await p
				.getByLabel('업로드 파일', { exact: true })
				.setInputFiles(
					await file(
						generated.documents.map((doc) => doc.sections[0].content).join(' '),
						'교대-업무.pptx'
					)
				);
			collapseTopics = true;
			let response = p.waitForResponse(
				(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
			);
			await create.click();
			assert.equal((await response).status(), 500);
			await p.getByRole('alert').filter({ hasText: '초안을 만들지 못했습니다' }).waitFor();
			assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 0);
			assert.equal(await p.getByRole('button', { name: /교대-업무.pptx/ }).count(), 1);
			await shot(p, `split-error-${width}-${theme}`);
			collapseTopics = false;
			response = p.waitForResponse(
				(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
			);
			await create.focus();
			await p.keyboard.press('Enter');
			assert.equal((await response).status(), 201);
			await p.getByRole('heading', { name: '3개의 초안이 준비됐어요.', exact: true }).waitFor();
			assert.equal(await p.locator('.generated-draft').count(), 3);
			assert.equal(await p.getByText(/각 초안은 별도의 위키 문서가 됩니다/).isVisible(), true);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `split-success-${width}-${theme}`);
			const drafts = await sql`SELECT * FROM drafts ORDER BY id`;
			assert.deepEqual(
				drafts.map((draft) => draft.title),
				generated.documents.map((doc) => doc.title)
			);
			assert.ok(
				drafts.every((draft) => draft.source_name === '교대-업무.pptx' && draft.status === 'review')
			);
			await p.locator(`.generated-draft[href="/drafts?open=${drafts[0].id}"]`).focus();
			await p.keyboard.press('Enter');
			await p.getByLabel('위키 본문', { exact: true }).waitFor();
			assert.equal(
				await p.getByLabel('위키 본문', { exact: true }).inputValue(),
				drafts[0].content
			);
			// Check every review URL independently, without depending on navigation state restoration.
			for (const draft of drafts) {
				await p.goto(base + '/drafts?open=' + draft.id, { waitUntil: 'networkidle' });
				assert.equal(await p.getByLabel('위키 본문', { exact: true }).inputValue(), draft.content);
				assert.equal(await p.locator('.sibling-drafts a').count(), 2);
			}
			await context.close();
			reports.push({
				width,
				theme,
				semanticSplit:
					'3 separate linked drafts; individual review; invalid collapsed result saves nothing; retry preserves selected file'
			});
		}
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			await state.clearDatabase();
			state.env.OPENAI_API_KEY = 'test-only-key';
			calls = [];
			const [oldDraft] =
				await sql`INSERT INTO drafts(title,slug,content) VALUES('기존 초안','old-draft','작성 중인 내용') RETURNING *`;
			const context = await browser.newContext({
				viewport: { width, height: 950 },
				reducedMotion: 'reduce'
			});
			await context.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
			await context.route('**/*', (route) => {
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
			const p = await context.newPage();
			p.on('pageerror', (error) => pageErrors.push(error.message));
			await p.goto(base + '/', { waitUntil: 'networkidle' });
			await openMainMenu(p);
			await p.getByRole('link', { name: 'AI 위키파이어', exact: true }).focus();
			await p.keyboard.press('Enter');
			const dialog = p.getByRole('dialog', { name: 'AI 위키파이어', exact: true });
			await dialog.waitFor();
			await dialog
				.getByLabel('업로드 파일', { exact: true })
				.setInputFiles(await file(source, '주제-검사.pptx'));
			const create = dialog.getByRole('button', { name: '위키 초안 만들기', exact: true });
			const blockedCase = blockedTopicCases[width === 360 ? 0 : width === 768 ? 1 : 4];
			plannedTopics = generated.documents.map(({ title }) => ({ title, scope: '점검 방법' }));
			plannedTopics.at(-1).scope = blockedCase.value;
			let release;
			gate = new Promise((resolve) => (release = resolve));
			let response = p.waitForResponse(
				(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
			);
			await create.focus();
			await p.keyboard.press('Enter');
			try {
				await dialog.getByText('문서를 읽고 초안을 만들고 있습니다…', { exact: true }).waitFor();
				assert.equal(
					await dialog.getByRole('button', { name: '초안 생성 중…', exact: true }).isDisabled(),
					true
				);
			} finally {
				release();
				gate = null;
			}
			assert.equal((await response).status(), 422);
			await dialog
				.getByRole('alert')
				.filter({ hasText: 'AI가 만든 문서 주제의 콘텐츠 보호 검사' })
				.waitFor();
			assert.equal(calls.length, 2);
			assert.ok(calls.every((request) => !request.input.includes('NotARealSecret42')));
			assert.equal(await dialog.isVisible(), true);
			assert.equal(await dialog.getByRole('button', { name: /주제-검사.pptx/ }).count(), 1);
			assert.equal(await create.isEnabled(), true);
			assert.deepEqual([...(await sql`SELECT * FROM drafts ORDER BY id`)], [oldDraft]);
			assert.ok(!(await dialog.innerText()).includes(blockedCase.value));
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `topic-blocked-${width}-${theme}`);
			plannedTopics = null;
			response = p.waitForResponse(
				(r) => r.url() === base + '/api/wikify' && r.request().method() === 'POST'
			);
			await create.focus();
			await p.keyboard.press('Enter');
			assert.equal((await response).status(), 201);
			await dialog
				.getByRole('heading', { name: '3개의 초안이 준비됐어요.', exact: true })
				.waitFor();
			assert.equal(calls.length, 5);
			assert.equal((await sql`SELECT count(*)::int n FROM drafts`)[0].n, 4);
			assert.deepEqual((await sql`SELECT * FROM drafts WHERE id=${oldDraft.id}`)[0], oldDraft);
			await shot(p, `topic-retry-${width}-${theme}`);
			await context.close();
			reports.push({
				width,
				theme,
				topicGuard: blockedCase.name,
				modalPreserved: true,
				keyboardRetry: true,
				existingDraftPreserved: true
			});
		}
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/browser-results.json',
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
