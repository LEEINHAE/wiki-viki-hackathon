import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.GOVERNANCE_BROWSER_OUTPUT ||
	(await mkdtemp(resolve(tmpdir(), 'wiki-governance-status-')));
const fixture = root + '/tests/fixtures/governance-database.js';
const base = 'http://127.0.0.1:4192';
process.env.DATABASE_URL = '';
process.env.OPENAI_API_KEY = '';
const originalFetch = globalThis.fetch;
let calls = [],
	mode = 'pass',
	gate = null,
	externalAttempts = 0;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (url === 'https://api.openai.com/v1/responses') {
		calls.push(JSON.parse(args[1].body));
		if (gate) await gate;
		if (mode === 'unavailable')
			return Response.json({ error: { message: 'synthetic service failure' } }, { status: 503 });
		return Response.json({
			object: 'response',
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [
						{
							type: 'output_text',
							text: JSON.stringify({
								passed: mode !== 'reject',
								reasons: mode === 'reject' ? ['확인이 필요한 인증 정보'] : []
							})
						}
					]
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
	cacheDir: output + '/cache',
	resolve: { alias: { '$env/dynamic/private': fixture } },
	server: { host: '127.0.0.1', port: 4192, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-governance-status',
			enforce: 'pre',
			resolveId(id) {
				if ([root + '/src/lib/server/db.js', '$lib/server/db.js', './db.js'].includes(id))
					return fixture;
			}
		}
	]
});
const state = await server.ssrLoadModule(fixture);
await state.setupDatabase({ maxConnections: 8 });
const sql = state.db();
const { getDraft } = await server.ssrLoadModule('/src/lib/server/draft-write.js');
const { getEditableDocument } = await server.ssrLoadModule('/src/lib/server/document-write.js');
const { createProposal, saveProposal } = await server.ssrLoadModule(
	'/src/lib/server/draft-merge.js'
);
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pageErrors = [],
	reports = [];
const skippedText = 'AI 의미 기반 검사는 실행되지 않았습니다. 내용을 직접 확인해 주세요.';
async function seed() {
	await state.clearDatabase();
	state.env.OPENAI_API_KEY = '';
	calls = [];
	mode = 'pass';
	const [doc] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('검사 상태 안내','governance-status','## 안내\n\n가상 업무 자료입니다.') RETURNING *`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${doc.id},${doc.content},'Editor-01')`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('status-alias','상태 별칭',${doc.id})`;
	const governance = {
		passed: true,
		regex: { passed: true, reasons: [] },
		semantic: { passed: true, reasons: [], skipped: true }
	};
	const [draft] =
		await sql`INSERT INTO drafts(title,slug,content,governance) VALUES('검사 상태 초안','governance-draft','## 설명\n\n검토할 가상 원문입니다.',${JSON.stringify(governance)}) RETURNING *`;
	return { doc, draft };
}
async function snapshot() {
	return (
		await sql`SELECT jsonb_build_object(
		'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
		'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),
		'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
		'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
		'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) data`
	)[0].data;
}
async function context(width, theme, javaScriptEnabled = true) {
	const c = await browser.newContext({
		viewport: { width, height: 950 },
		reducedMotion: 'reduce',
		javaScriptEnabled
	});
	await c.addInitScript((theme) => localStorage.setItem('wiki-theme', theme), theme);
	await c.route('**/*', (route) => {
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
	const p = await c.newPage();
	p.on('pageerror', (error) => pageErrors.push(error.message));
	return { c, p };
}
async function submit(p, button) {
	const pending = p.waitForResponse(
		(r) => r.request().method() === 'POST' && r.url().startsWith(base + '/')
	);
	await button.focus();
	await p.keyboard.press('Enter');
	const response = await pending;
	const result = await response.json();
	return result.status;
}
try {
	for (const [width, theme, javaScriptEnabled] of [
		...[360, 768, 1440].flatMap((width) => ['light', 'dark'].map((theme) => [width, theme, true])),
		[768, 'light', false]
	]) {
		const { draft } = await seed();
		const before = await snapshot();
		const { c, p } = await context(width, theme, javaScriptEnabled);
		const routes = [
			['/edit/governance-status', '제목·본문·별칭·편집 요약을 직접 검토'],
			['/history/governance-status', '복원할 본문을 직접 검토'],
			['/discussion/governance-status', '검토한 뒤 등록해 주세요.'],
			['/drafts?open=' + draft.id, skippedText],
			['/drafts', 'AI 의미 검사 생략 · 직접 확인해 주세요.']
		];
		for (const [path, text] of routes) {
			await p.goto(base + path, { waitUntil: 'networkidle' });
			await p.getByText(text, { exact: false }).waitFor();
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
				false
			);
			const view = path.startsWith('/drafts?') ? 'draft-detail' : path.split('/')[1];
			await p.screenshot({
				path: `${output}/skipped-${view}-${width}-${theme}-${javaScriptEnabled}.png`,
				fullPage: true
			});
		}
		assert.equal(calls.length, 0);
		assert.deepEqual(await snapshot(), before);
		state.env.OPENAI_API_KEY = 'test-only-key';
		for (const [path] of routes.slice(0, 3)) {
			await p.goto(base + path, { waitUntil: 'networkidle' });
			assert.equal(await p.getByText(/AI 의미 기반 검사는 실행되지 않습니다/).count(), 0);
		}
		// Configuring a key must not invent a completed inspection for old drafts.
		await p.goto(base + '/drafts?open=' + draft.id, { waitUntil: 'networkidle' });
		await p.getByText(skippedText, { exact: true }).waitFor();
		assert.equal(calls.length, 0);
		assert.deepEqual(await snapshot(), before);
		if (javaScriptEnabled) {
			assert.equal(
				await submit(p, p.getByRole('button', { name: '검토 내용 저장', exact: true })),
				303
			);
			await p.getByText(skippedText, { exact: true }).waitFor({ state: 'hidden' });
			const [saved] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
			assert.equal(saved.governance.semantic.skipped, false);
			assert.equal(saved.governance.semantic.passed, true);
			assert.equal(saved.content, draft.content);
			assert.equal(calls.length, 1);
		}
		reports.push({
			width,
			theme,
			javaScriptEnabled,
			skippedRoutes: routes.length,
			keyConfiguredDoesNotReinspect: true
		});
		await c.close();
	}
	for (const [width, theme] of [
		[360, 'light'],
		[1440, 'dark']
	]) {
		let { doc, draft } = await seed();
		const { c, p } = await context(width, theme);
		await p.goto(base + '/drafts', { waitUntil: 'networkidle' });
		await p.getByRole('checkbox', { name: draft.title + ' 검토 완료로 선택', exact: true }).check();
		assert.equal(
			await submit(p, p.getByRole('button', { name: '선택한 초안 게시', exact: true })),
			200
		);
		await p
			.getByText('AI 의미 검사가 생략된 문서가 있습니다. 직접 검토한 내용으로 게시했습니다.', {
				exact: true
			})
			.waitFor();
		assert.equal(calls.length, 0);
		const [published] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
		assert.equal(published.status, 'published');
		assert.equal(published.governance.semantic.skipped, true);
		assert.equal((await sql`SELECT count(*)::int n FROM documents`)[0].n, 2);
		await p.screenshot({ path: `${output}/batch-skipped-${width}-${theme}.png`, fullPage: true });
		reports.push({ width, theme, keylessBatchResult: true, externalCalls: calls.length });
		({ doc, draft } = await seed());
		const current = await getDraft(sql, draft.id);
		const target = await getEditableDocument('', doc.id);
		const content = '## 직접 검토한 통합\n\n기존 안내와 초안 설명을 함께 확인합니다.';
		const proposal = createProposal(current, target, {
			model: 'test-only',
			result: { content, summary: '가상 검토 자료', conflicts: [] }
		});
		assert.equal(await saveProposal(sql, current, target, proposal), true);
		await p.goto(base + '/drafts?open=' + draft.id, { waitUntil: 'networkidle' });
		await p
			.getByText(
				'AI 의미 기반 검사는 실행되지 않습니다. 저장된 통합안과 최종 본문을 직접 검토한 뒤 적용해 주세요.',
				{ exact: true }
			)
			.waitFor();
		await p
			.getByText('AI 통합안 생성이 연결되지 않았습니다. API 키 설정 후 사용할 수 있습니다.', {
				exact: true
			})
			.waitFor();
		await p.locator('[name="confirmMerge"]').check();
		await p.screenshot({ path: `${output}/merge-skipped-${width}-${theme}.png`, fullPage: true });
		assert.equal(
			await submit(p, p.getByRole('button', { name: '검토 완료 · 기존 문서에 통합', exact: true })),
			303
		);
		await p.waitForURL(base + '/wiki/governance-status');
		assert.equal(calls.length, 0);
		assert.equal((await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content, content);
		assert.equal(
			(await sql`SELECT count(*)::int n FROM revisions WHERE document_id=${doc.id}`)[0].n,
			2
		);
		const [merged] = await sql`SELECT * FROM drafts WHERE id=${draft.id}`;
		assert.equal(merged.status, 'published');
		assert.equal(merged.governance.semantic.skipped, true);
		reports.push({ width, theme, keylessStoredMerge: true, externalCalls: calls.length });
		await c.close();
	}
	for (const [width, theme] of [
		[360, 'light'],
		[1440, 'dark']
	]) {
		await seed();
		state.env.OPENAI_API_KEY = 'test-only-key';
		const before = await snapshot();
		const { c, p } = await context(width, theme);
		await p.goto(base + '/discussion/governance-status', { waitUntil: 'networkidle' });
		const button = p.getByRole('button', { name: '토론 등록', exact: true });
		await p.getByLabel('주제', { exact: true }).fill('검사 결과 확인');
		await p.getByLabel('의견', { exact: true }).fill('password=NotARealSecret42!');
		assert.equal(await submit(p, button), 400);
		await p.getByRole('alert').filter({ hasText: '콘텐츠 보호 검사로 등록이 차단' }).waitFor();
		assert.equal(calls.length, 0);
		assert.deepEqual(await snapshot(), before);
		const content = '담당자 test.user@example.invalid의 가상 업무 의견입니다.';
		await p.getByLabel('의견', { exact: true }).fill(content);
		mode = 'reject';
		assert.equal(await submit(p, button), 400);
		await p.getByRole('alert').filter({ hasText: '콘텐츠 보호 검사로 등록이 차단' }).waitFor();
		assert.equal(calls.length, 1);
		assert.deepEqual(await snapshot(), before);
		mode = 'unavailable';
		let release;
		gate = new Promise((resolve) => (release = resolve));
		const pending = submit(p, button);
		try {
			await p.getByRole('button', { name: '검사 후 등록 중…', exact: true }).waitFor();
			assert.equal(await p.getByLabel('의견', { exact: true }).isDisabled(), true);
		} finally {
			release();
			gate = null;
		}
		assert.equal(await pending, 503);
		await p
			.getByRole('alert')
			.filter({ hasText: 'AI 의미 검사를 완료하지 못해 등록하지 않았습니다' })
			.waitFor();
		assert.equal(await p.getByText(/AI 의미 기반 검사는 실행되지 않습니다/).count(), 0);
		assert.equal(await p.getByLabel('의견', { exact: true }).inputValue(), content);
		assert.equal(calls.length, 2);
		assert.deepEqual(await snapshot(), before);
		await p.screenshot({ path: `${output}/unavailable-${width}-${theme}.png`, fullPage: true });
		mode = 'pass';
		assert.equal(await submit(p, button), 200);
		await p.getByRole('status').filter({ hasText: '토론을 등록했습니다.' }).waitFor();
		assert.equal(calls.length, 3);
		const [thread] = await sql`SELECT * FROM discussions`;
		assert.equal(thread.body, content);
		assert.deepEqual({ ...(await snapshot()), discussions: before.discussions }, before);
		reports.push({
			width,
			theme,
			localBlockedRequests: 0,
			semanticRejection: true,
			unavailablePreservesInput: true,
			retrySavedOnce: true
		});
		await c.close();
	}
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	const result = { reports, pageErrors, externalAttempts, mockedAI: true, output };
	await writeFile(output + '/results.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
