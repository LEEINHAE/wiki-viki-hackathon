import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { recoveryLifetime } from '../../src/lib/recovery-store.js';
import { draftRecoveryStore } from '../../src/lib/draft-recovery.js';
const recoveryPrefix = draftRecoveryStore.prefix;
const generated = {
	content: '통합 원안\n\n보관 주의 사항',
	summary: '초안 내용을 반영',
	conflicts: []
};
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.RECOVERY_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-draft-recovery-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	port = 4189,
	base = `http://127.0.0.1:${port}`;
// The fixture rejects remote/non-test databases and requires explicit RUN_GOVERNANCE_DB_TESTS=1.
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const originalFetch = globalThis.fetch;
let externalAttempts = 0,
	mockCalls = 0,
	mode = 'normal',
	gate = null;
globalThis.fetch = async (...args) => {
	const url = typeof args[0] === 'string' ? args[0] : args[0].url;
	if (url === 'https://api.openai.com/v1/responses') {
		mockCalls++;
		const merging = JSON.parse(args[1].body).text?.format?.name === 'wiki_merge';
		if (gate) await gate;
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
							text: JSON.stringify(
								merging
									? generated
									: {
											passed: mode === 'unavailable' ? 'invalid' : mode !== 'reject',
											reasons: mode === 'reject' ? ['보호 검사 거부'] : []
										}
							)
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
	cacheDir: output + '/browser-cache',
	resolve: { alias: { '$env/dynamic/private': fixture } },
	server: { host: '127.0.0.1', port, strictPort: true, watch: null },
	plugins: [
		{
			name: 'isolated-recovery-browser',
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
	reports = [],
	pageErrors = [],
	policies = new WeakMap();
const body = (p) => p.getByLabel('위키 본문', { exact: true }),
	choice = (p) =>
		p.getByRole('checkbox', {
			name: '민감 정보가 없는 입력을 이 브라우저에 24시간 임시 보관',
			exact: true
		}),
	restore = (p) => p.getByRole('button', { name: '이 입력 복구', exact: true }),
	save = (p) => p.getByRole('button', { name: '검토 내용 저장', exact: true });
async function seed() {
	await state.clearDatabase();
	state.env.OPENAI_API_KEY = '';
	mode = 'normal';
	gate = null;
	const [doc] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('검증 문서','recovery-check','저장된 문서 본문') RETURNING *`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${doc.id},${doc.content},'Editor-01','원본')`;
	const [draft] =
		await sql`INSERT INTO drafts(title,slug,content,source_name,aliases,governance) VALUES('검증 초안','검증-초안','저장된 초안 본문','공개 검증.docx','["검증 문서"]','{"passed":true,"semantic":{"passed":true,"skipped":false}}') RETURNING *`;
	const [sibling] =
		await sql`INSERT INTO drafts(title,slug,content,source_name,created_at) VALUES('같은 원본 초안','sibling','형제 초안',${draft.source_name},${draft.created_at}) RETURNING *`;
	return { doc, draft, sibling };
}
async function context(options = {}) {
	const c = await browser.newContext({
		viewport: { width: 768, height: 950 },
		reducedMotion: 'reduce',
		...options
	});
	await c.addInitScript(() => localStorage.setItem('wiki-theme', 'dark'));
	return c;
}
async function page(c) {
	const p = await c.newPage(),
		policy = { accept: false, dialogs: [] };
	policies.set(p, policy);
	p.on('dialog', async (d) => {
		policy.dialogs.push(d.type());
		await (policy.accept ? d.accept() : d.dismiss());
	});
	p.on('pageerror', (e) => pageErrors.push(e.message));
	p.on('console', (m) => {
		if (m.type() === 'warning' && m.text().includes('[svelte]')) pageErrors.push(m.text());
	});
	return p;
}
async function open(p, id, theme = 'dark') {
	await p.goto(base + '/drafts?open=' + id, { waitUntil: 'networkidle' });
	await p.getByRole('heading', { name: '임시 입력 복구', exact: true }).waitFor();
	if (theme === 'light')
		await p.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click();
}
async function records(p) {
	return p.evaluate(
		(prefix) =>
			Object.keys(localStorage)
				.filter((k) => k.startsWith(prefix))
				.map((k) => ({ key: k, ...JSON.parse(localStorage.getItem(k)) })),
		recoveryPrefix
	);
}
async function stored(p, count = 1) {
	await p.waitForFunction(
		({ prefix, count }) =>
			Object.keys(localStorage).filter((k) => k.startsWith(prefix)).length === count,
		{ prefix: recoveryPrefix, count }
	);
}
async function shot(p, name) {
	await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
}
async function submit(p, button = save(p)) {
	const response = p.waitForResponse(
		(r) => r.request().method() === 'POST' && r.url().includes('/drafts')
	);
	await button.focus();
	await p.keyboard.press('Enter');
	const r = await response,
		payload = r.headers()['content-type']?.includes('application/json') ? await r.json() : null;
	await p.waitForLoadState('networkidle');
	await p.locator('.wiki-form[aria-busy="true"]').waitFor({ state: 'detached' });
	return payload?.status ?? r.status();
}
async function cancelNavigation(p) {
	const dialog = p.waitForEvent('dialog');
	await p.getByRole('link', { name: '← 목록으로', exact: true }).click();
	await dialog;
}
async function reload(p) {
	policies.get(p).accept = true;
	await p.reload({ waitUntil: 'networkidle' });
	policies.get(p).accept = false;
}
const finalBody = (p) => p.getByLabel('최종 통합 본문', { exact: true }),
	reviewer = (p) => p.getByLabel('통합 검토자 이름', { exact: true }),
	confirm = (p) => p.locator('[name="confirmMerge"]'),
	apply = (p) => p.getByRole('button', { name: '검토 완료 · 기존 문서에 통합', exact: true }),
	generate = (p) => p.getByRole('button', { name: /^AI 통합안 (다시 )?생성$/ }),
	target = (p) => p.locator('[name="target"]');
async function proposed(p, draft) {
	state.env.OPENAI_API_KEY = 'test-only-key';
	await open(p, draft.id);
	assert.equal(await submit(p, generate(p)), 303);
	await p.getByRole('heading', { name: 'AI 통합안 검토', exact: true }).waitFor();
}
async function recover(p, index = 0) {
	policies.get(p).accept = true;
	await restore(p).nth(index).click();
	await p
		.getByText(
			'입력을 복구했습니다. 원래 검토 버전을 유지해 저장할 때 현재 초안과 다시 비교합니다. 원본 복구본은 목록에서 삭제할 수 있습니다.',
			{ exact: true }
		)
		.waitFor();
	policies.get(p).accept = false;
}
async function backedUp(p, field, value) {
	await p.waitForFunction(
		({ prefix, field, value }) =>
			Object.keys(localStorage)
				.filter((k) => k.startsWith(prefix))
				.some((k) => JSON.parse(localStorage.getItem(k)).values[field] === value),
		{ prefix: recoveryPrefix, field, value }
	);
}
async function go(p, url) {
	policies.get(p).accept = true;
	await p.goto(url, { waitUntil: 'networkidle' });
	policies.get(p).accept = false;
}
async function compareInputs(p, inputs) {
	for (const [name, value] of Object.entries(inputs))
		assert.equal(
			(await p.locator(`[name="${name}"]`).inputValue()).replaceAll('\r\n', '\n'),
			value
		);
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { draft, sibling } = await seed(),
				c = await context({ viewport: { width, height: 950 } }),
				p = await page(c);
			await open(p, draft.id, theme);
			assert.equal(await choice(p).isChecked(), false);
			await shot(p, `empty-${width}-${theme}`);
			const version = await p.locator('[name="version"]').inputValue();
			const inputs = {
				title: '보존할 초안 제목',
				content: '작성 중 본문\n\n[[문서]]\n\n마지막 줄',
				aliases: '쉼표, 별칭\n다른 별칭',
				editor: 'Editor-77'
			};
			for (const [name, value] of Object.entries(inputs))
				await p.locator(`[name="${name}"]`).fill(value);
			await delay(500);
			assert.equal((await records(p)).length, 0);
			await cancelNavigation(p);
			assert.equal(policies.get(p).dialogs.at(-1), 'confirm');
			assert.match(p.url(), new RegExp('open=' + draft.id));
			const calls = mockCalls;
			await choice(p).focus();
			await p.keyboard.press('Space');
			await backedUp(p, 'content', inputs.content);
			assert.equal(mockCalls, calls);
			await p.locator('[name="confirmDelete"]').check();
			const snapshot = (await records(p))[0];
			assert.equal(snapshot.values.id, String(draft.id));
			assert.equal(snapshot.values.version, version);
			assert.equal(Object.hasOwn(snapshot.values, 'confirmDelete'), false);
			const navigation = p.waitForEvent('dialog');
			await p.getByRole('link', { name: sibling.title + ' ↗', exact: true }).click();
			await navigation;
			assert.match(p.url(), new RegExp('open=' + draft.id));
			policies.get(p).accept = true;
			const leaving = p.waitForEvent('dialog');
			await p.getByRole('link', { name: '← 목록으로', exact: true }).click();
			await leaving;
			await p.waitForURL(base + '/drafts');
			policies.get(p).accept = false;
			await p.getByRole('link', { name: '수정·통합 검증 초안 →', exact: true }).click();
			await restore(p).waitFor();
			assert.equal(await body(p).inputValue(), draft.content);
			await recover(p);
			await compareInputs(p, inputs);
			assert.equal(await p.locator('[name="version"]').inputValue(), version);
			assert.equal(await p.locator('[name="confirmDelete"]').isChecked(), false);
			await reload(p);
			assert.equal(policies.get(p).dialogs.at(-1), 'beforeunload');
			await recover(p);
			if (theme === 'light')
				await p.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click();
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			await compareInputs(p, inputs);
			assert.equal(
				await p.getByRole('button', { name: '검토 완료 · 문서 게시', exact: true }).isDisabled(),
				true
			);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `restored-${width}-${theme}`);
			assert.equal(await submit(p), 303);
			assert.equal(
				(await sql`SELECT content FROM drafts WHERE id=${draft.id}`)[0].content,
				inputs.content
			);
			assert.equal(await choice(p).isChecked(), false);
			const count = (await records(p)).length;
			await body(p).fill('성공 후 새 입력');
			await cancelNavigation(p);
			assert.match(p.url(), new RegExp('open=' + draft.id));
			assert.equal(await body(p).inputValue(), '성공 후 새 입력');
			await choice(p).check();
			await backedUp(p, 'content', '성공 후 새 입력');
			assert.equal((await records(p)).length, count + 1);
			await c.close();
			reports.push({
				width,
				theme,
				normal:
					'default off; keyboard opt-in; list/sibling/reload recovery; original version; no delete approval; same-page save re-arms warnings and backup'
			});
		}
	// Both ordinary and final edits restore together; explicit discard is required before normal saving.
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const { draft, doc } = await seed(),
				c = await context({ viewport: { width, height: 950 } }),
				p = await page(c);
			await proposed(p, draft);
			if (theme === 'light')
				await p.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click();
			const version = await p.locator('[name="version"]').inputValue(),
				proposalId = await p.locator('[name="proposalId"]').inputValue(),
				originalTarget = await target(p).inputValue();
			await body(p).fill('일반 수정과 함께 보존');
			await finalBody(p).fill('편집한 최종 본문\n\n보관 주의 유지');
			await reviewer(p).fill('Editor-88');
			await choice(p).check();
			await backedUp(p, 'mergeEditor', 'Editor-88');
			await p.locator('[name="confirmResetMerge"]').check();
			await reload(p);
			await recover(p);
			assert.equal(await body(p).inputValue(), '일반 수정과 함께 보존');
			assert.equal(await finalBody(p).inputValue(), '편집한 최종 본문\n\n보관 주의 유지');
			assert.equal(await reviewer(p).inputValue(), 'Editor-88');
			assert.equal(await p.locator('[name="version"]').inputValue(), version);
			assert.equal(await p.locator('[name="proposalId"]').inputValue(), proposalId);
			assert.equal(await target(p).inputValue(), originalTarget);
			assert.equal(await p.locator('[name="confirmResetMerge"]').isChecked(), false);
			assert.equal(await confirm(p).isChecked(), false);
			assert.equal(await save(p).isDisabled(), true);
			assert.equal(await apply(p).isDisabled(), true);
			await body(p).fill(draft.content);
			await confirm(p).check();
			await reload(p);
			await recover(p);
			assert.equal(await confirm(p).isChecked(), false);
			if (theme === 'light')
				await p.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click();
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			assert.equal(
				await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
				true
			);
			await shot(p, `merge-restored-${width}-${theme}`);
			assert.equal(await submit(p, apply(p)), 400);
			assert.equal(await finalBody(p).inputValue(), '편집한 최종 본문' + '\n\n보관 주의 유지');
			await confirm(p).check();
			assert.equal(await submit(p, apply(p)), 303);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
				'편집한 최종 본문\n\n보관 주의 유지'
			);
			assert.equal(
				(await sql`SELECT status FROM drafts WHERE id=${draft.id}`)[0].status,
				'published'
			);
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM revisions WHERE document_id=${doc.id}`)[0].n,
				2
			);
			await c.close();
			reports.push({
				width,
				theme,
				merge:
					'normal/final fields and exact proposal/target restored; no approvals; final application requires fresh review and commits once'
			});
		}
	// Stale backup must not become approval of a newer draft version.
	{
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('오래된 복구 입력');
		await choice(p).check();
		await backedUp(p, 'content', '오래된 복구 입력');
		const version = await p.locator('[name="version"]').inputValue();
		await sql`UPDATE drafts SET content='다른 작성자의 새 내용',updated_at=clock_timestamp() WHERE id=${draft.id}`;
		await reload(p);
		await recover(p);
		assert.equal(await p.locator('[name="version"]').inputValue(), version);
		assert.equal(await save(p).isDisabled(), true);
		await p.getByRole('region', { name: '현재 저장된 초안과 비교', exact: true }).waitFor();
		assert.equal(
			await p.getByLabel('현재 저장된 본문', { exact: true }).inputValue(),
			'다른 작성자의 새 내용'
		);
		await shot(p, 'conflict-768-dark');
		assert.equal(
			await submit(p, p.getByRole('button', { name: '비교 후 내 수정 내용 저장', exact: true })),
			303
		);
		assert.equal(
			(await sql`SELECT content FROM drafts WHERE id=${draft.id}`)[0].content,
			'오래된 복구 입력'
		);
		await c.close();
		reports.push({
			conflict: 'old token retained; comparison required; explicit resolution saves'
		});
	}
	// A changed/removed proposal cannot apply recovered final edits against the current proposal.
	for (const change of ['discard', 'replace', 'target', 'trash']) {
		const { draft, doc } = await seed(),
			c = await context(),
			p = await page(c);
		await proposed(p, draft);
		await finalBody(p).fill('최종 입력 유지 ' + change);
		await reviewer(p).fill('Editor-77');
		await choice(p).check();
		await backedUp(p, 'mergeEditor', 'Editor-77');
		const proposalId = await p.locator('[name="proposalId"]').inputValue(),
			selectedTarget = await target(p).inputValue();
		if (change === 'discard')
			await sql`UPDATE drafts SET governance=governance-'merge' WHERE id=${draft.id}`;
		if (change === 'replace')
			await sql`UPDATE drafts SET governance=jsonb_set(governance,'{merge,id}','"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"') WHERE id=${draft.id}`;
		if (change === 'target')
			await sql`UPDATE documents SET content='대상 변경',updated_at=clock_timestamp() WHERE id=${doc.id}`;
		if (change === 'trash')
			await sql`UPDATE documents SET deleted_at=clock_timestamp(),deleted_by='Editor-01',lifecycle_version=lifecycle_version+1 WHERE id=${doc.id}`;
		await reload(p);
		await recover(p);
		assert.equal(await p.locator('[name="proposalId"]').inputValue(), proposalId);
		assert.equal(await finalBody(p).inputValue(), '최종 입력 유지 ' + change);
		if (change === 'discard' || change === 'replace') {
			assert.equal(await apply(p).count(), 0);
			await p.getByRole('heading', { name: '작성 중인 최종 통합 입력', exact: true }).waitFor();
		} else {
			assert.equal(await apply(p).isDisabled(), true);
			if (change === 'target') assert.equal(await target(p).inputValue(), selectedTarget);
		}
		await shot(p, 'proposal-' + change);
		assert.equal((await sql`SELECT status FROM drafts WHERE id=${draft.id}`)[0].status, 'review');
		await c.close();
	}
	reports.push({
		staleMerge:
			'discarded/replaced proposal and changed/trashed target retain final text; apply unavailable; original IDs retained'
	});
	// Storage is separate across tabs and drafts. Deletion from one tab disables resurrection in the owner.
	{
		const { draft, sibling } = await seed(),
			c = await context(),
			p = await page(c),
			q = await page(c);
		await open(p, draft.id);
		await body(p).fill('첫 탭 입력');
		await choice(p).check();
		await backedUp(p, 'content', '첫 탭 입력');
		await open(q, draft.id);
		await body(q).fill('둘째 탭 입력');
		await choice(q).check();
		await backedUp(q, 'content', '둘째 탭 입력');
		await stored(p, 2);
		assert.equal(await q.locator('.recovery-copy').count(), 1);
		await q.getByRole('button', { name: '이 복구본 삭제', exact: true }).click();
		await stored(p, 1);
		await p
			.getByText(
				'다른 탭에서 이 복구본을 삭제해 임시 보관을 중지했습니다. 화면의 입력은 유지했습니다.',
				{ exact: true }
			)
			.waitFor();
		assert.equal(await choice(p).isChecked(), false);
		await body(p).fill('삭제 후 추가 입력');
		await delay(500);
		await stored(p, 1);
		await go(p, base + '/drafts?open=' + sibling.id);
		assert.equal(await restore(p).count(), 0);
		assert.equal(await body(p).inputValue(), sibling.content);
		await body(p).fill('다른 초안 입력');
		await choice(p).check();
		await backedUp(p, 'content', '다른 초안 입력');
		await choice(p).uncheck();
		await stored(q, 1);
		assert.equal(await body(q).inputValue(), '둘째 탭 입력');
		await c.close();
		reports.push({
			tabs: 'independent tab/draft keys; explicit deletion disables owner autosave; opting out removes only current copy'
		});
	}
	// Actual DB failure rolls back; retry retains exact input and successful same-page reset works.
	{
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('DB 실패 시 보존');
		await choice(p).check();
		await backedUp(p, 'content', 'DB 실패 시 보존');
		await sql`CREATE FUNCTION recovery_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-draft-failure'; END $$`;
		await sql`CREATE TRIGGER recovery_fail BEFORE UPDATE ON drafts FOR EACH ROW EXECUTE FUNCTION recovery_fail()`;
		try {
			assert.equal(await submit(p), 503);
			assert.equal(await body(p).inputValue(), 'DB 실패 시 보존');
			assert.equal(
				(await sql`SELECT content FROM drafts WHERE id=${draft.id}`)[0].content,
				draft.content
			);
			assert.equal((await records(p)).length, 1);
			assert.doesNotMatch(await p.locator('body').innerText(), /private-draft-failure/);
			await shot(p, 'db-error-768-dark');
		} finally {
			await sql`DROP TRIGGER recovery_fail ON drafts`;
			await sql`DROP FUNCTION recovery_fail()`;
		}
		assert.equal(await submit(p), 303);
		assert.equal(
			(await sql`SELECT content FROM drafts WHERE id=${draft.id}`)[0].content,
			'DB 실패 시 보존'
		);
		assert.equal((await records(p)).length, 0);
		await c.close();
		reports.push({
			database:
				'actual UPDATE trigger failure returns 503, rolls back and retains inputs/copy; retry succeeds'
		});
	}
	// Semantic rejection on a same-URL redirect must purge the original restored copy too.
	{
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('의미 검토 대상');
		await choice(p).check();
		await backedUp(p, 'content', '의미 검토 대상');
		await reload(p);
		await recover(p);
		await stored(p, 2);
		state.env.OPENAI_API_KEY = 'test-only-key';
		mode = 'reject';
		assert.equal(await submit(p), 303);
		await stored(p, 0);
		assert.equal(await choice(p).isDisabled(), true);
		assert.equal((await sql`SELECT status FROM drafts WHERE id=${draft.id}`)[0].status, 'blocked');
		assert.equal(await body(p).inputValue(), '의미 검토 대상');
		await body(p).fill('후속 입력');
		await p.locator('[name="title"]').fill('!!!');
		assert.equal(await submit(p), 400);
		assert.equal(await choice(p).isDisabled(), true);
		await stored(p, 0);
		await c.close();
		reports.push({
			semanticDraft:
				'rejected content redirects as blocked; original restored copy purged; later validation error cannot enable storage'
		});
	}
	// Merge rejection remains in memory across subsequent errors. Slow inspection disables editing.
	{
		const { draft, doc } = await seed(),
			c = await context(),
			p = await page(c);
		await proposed(p, draft);
		await finalBody(p).fill('의미 검사 대상 최종 편집');
		await choice(p).check();
		await backedUp(p, 'finalContent', '의미 검사 대상 최종 편집');
		await reload(p);
		await recover(p);
		await stored(p, 2);
		mode = 'reject';
		await confirm(p).check();
		let release;
		gate = new Promise((r) => (release = r));
		const started = submit(p, apply(p));
		await p
			.getByText('최종 내용을 검사하고 기존 문서에 반영하고 있습니다.', { exact: true })
			.waitFor();
		assert.equal(await finalBody(p).isDisabled(), true);
		assert.equal(await body(p).isDisabled(), true);
		await shot(p, 'merge-loading-768-dark');
		release();
		gate = null;
		assert.equal(await started, 400);
		await stored(p, 0);
		assert.equal(await choice(p).isDisabled(), true);
		assert.equal(await finalBody(p).inputValue(), '의미 검사 대상 최종 편집');
		await reviewer(p).fill('잘못된 이름');
		await confirm(p).check();
		assert.equal(await submit(p, apply(p)), 400);
		assert.equal(await choice(p).isDisabled(), true);
		await stored(p, 0);
		assert.equal(
			(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
			doc.content
		);
		await c.close();
		reports.push({
			semanticMerge:
				'rejected final text purged in all matching copies; later validation failure stays protected; pending AI locks inputs'
		});
	}
	// Local sensitive input never reaches storage or automatically invokes AI, including final input and source name.
	for (const field of ['content', 'finalContent', 'sourceName']) {
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		if (field === 'sourceName')
			await sql`UPDATE drafts SET source_name='900101-1000000 자료.docx' WHERE id=${draft.id}`;
		if (field === 'finalContent') await proposed(p, draft);
		else await open(p, draft.id);
		const calls = mockCalls;
		if (field === 'finalContent') await finalBody(p).fill('900101-1000000');
		else await body(p).fill(field === 'sourceName' ? '공개 입력' : '900101-1000000');
		assert.equal(await choice(p).isDisabled(), true);
		await cancelNavigation(p);
		assert.equal(mockCalls, calls);
		await stored(p, 0);
		await c.close();
	}
	reports.push({
		localProtection:
			'body/final body/source name block persistence; input stays on page; no automatic AI calls'
	});
	// Explicit deletion retains local unsaved copy; deleted/published/missing rows can only be copied, not recreated.
	for (const status of ['delete', 'published', 'missing']) {
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('서버 종료 후 복사할 입력');
		await choice(p).check();
		await backedUp(p, 'content', '서버 종료 후 복사할 입력');
		if (status === 'delete') {
			await p.locator('[name="confirmDelete"]').check();
			assert.equal(await submit(p, p.getByRole('button', { name: '초안 삭제', exact: true })), 303);
		} else if (status === 'published')
			await sql`UPDATE drafts SET status='published' WHERE id=${draft.id}`;
		else await sql`DELETE FROM drafts WHERE id=${draft.id}`;
		await go(p, base + '/drafts?open=' + draft.id);
		await recover(p);
		assert.equal(await body(p).inputValue(), '서버 종료 후 복사할 입력');
		assert.equal(await save(p).isDisabled(), true);
		assert.equal(
			await p.getByRole('button', { name: '검토 완료 · 문서 게시', exact: true }).isDisabled(),
			true
		);
		assert.equal(await p.getByRole('button', { name: '초안 삭제', exact: true }).count(), 0);
		await shot(p, 'missing-' + status);
		assert.equal(
			(await sql`SELECT id FROM drafts WHERE id=${draft.id} AND status<>'published'`).length,
			0
		);
		await c.close();
	}
	reports.push({
		removed:
			'explicit server deletion preserves local copy; deleted/published/missing draft restores copyable input with actions disabled'
	});
	// Storage denial, quota and expiry surface a truthful recoverability state.
	{
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('보관된 이전 입력');
		await choice(p).check();
		await backedUp(p, 'content', '보관된 이전 입력');
		await p.evaluate(() => {
			const original = Storage.prototype.setItem;
			Storage.prototype.setItem = function (k, v) {
				if (k.startsWith('wiki-viki:draft-recovery:'))
					throw new DOMException('Quota', 'QuotaExceededError');
				return original.call(this, k, v);
			};
		});
		await body(p).fill('용량 부족 후 입력');
		await p.getByRole('alert').filter({ hasText: '임시' }).waitFor();
		assert.equal((await records(p))[0].values.content, '보관된 이전 입력');
		assert.equal(await body(p).inputValue(), '용량 부족 후 입력');
		await cancelNavigation(p);
		await shot(p, 'quota-error-768-dark');
		await reload(p);
		const entries = await records(p);
		await p.evaluate(
			({ entries, lifetime }) => {
				for (const r of entries) {
					r.savedAt = Date.now() - lifetime - 1;
					r.expiresAt = r.savedAt + lifetime;
					localStorage.setItem(r.key, JSON.stringify(r));
				}
			},
			{ entries, lifetime: recoveryLifetime }
		);
		await recoverExpired(p);
		await stored(p, 0);
		assert.equal(await body(p).inputValue(), draft.content);
		await c.close();
	}
	async function recoverExpired(p) {
		await restore(p).first().click();
		await p
			.getByText('복구본이 만료되었거나 삭제되었습니다. 현재 입력은 바꾸지 않았습니다.', {
				exact: true
			})
			.waitFor();
	}
	{
		const { draft } = await seed(),
			c = await context();
		await c.addInitScript(() => {
			Object.defineProperty(window, 'localStorage', {
				get() {
					throw new DOMException('denied', 'SecurityError');
				}
			});
		});
		const p = await page(c);
		await open(p, draft.id);
		await p.getByRole('alert').filter({ hasText: '임시' }).waitFor();
		await body(p).fill('저장소 거부 후 입력');
		await cancelNavigation(p);
		assert.equal(await body(p).inputValue(), '저장소 거부 후 입력');
		await c.close();
	}
	reports.push({
		storage:
			'quota preserves previous complete copy/current input; restore rechecks expiry; denied storage retains input and navigation warning'
	});
	// Server-rendered/no-JS forms retain defaults and rejected final input, with explicit recovery limitation.
	{
		const { draft } = await seed(),
			prep = await context(),
			p = await page(prep);
		await proposed(p, draft);
		await prep.close();
		const c = await context({ javaScriptEnabled: false }),
			n = await page(c);
		await n.goto(base + '/drafts?open=' + draft.id);
		assert.equal(await body(n).inputValue(), draft.content);
		assert.equal(await finalBody(n).inputValue(), generated.content);
		assert.equal(await choice(n).isDisabled(), true);
		assert.equal(
			await n.locator('noscript p').filter({ hasText: '임시 복구와 이동 전 안내' }).isVisible(),
			true
		);
		await shot(n, 'native-loading-768-light');
		await finalBody(n).fill('기본 폼 최종 편집');
		await reviewer(n).fill('Editor-88');
		await confirm(n).focus();
		await n.keyboard.press('Space');
		await sql`UPDATE drafts SET governance=governance-'merge' WHERE id=${draft.id}`;
		assert.equal(await submit(n, apply(n)), 409);
		assert.equal(await finalBody(n).inputValue(), '기본 폼 최종 편집');
		await n.getByRole('heading', { name: '작성 중인 최종 통합 입력', exact: true }).waitFor();
		await shot(n, 'native-conflict-768-light');
		await c.close();
	}
	reports.push({
		noJavaScript:
			'SSR ordinary/final values; opt-in disabled and limitation; stale proposal native 409 retains final input'
	});
	// A late response for the draft just left must never replace the next draft's input.
	{
		const { draft, sibling } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('첫 초안 저장 대기');
		await choice(p).check();
		await backedUp(p, 'content', '첫 초안 저장 대기');
		state.env.OPENAI_API_KEY = 'test-only-key';
		let release;
		gate = new Promise((r) => (release = r));
		const pending = submit(p);
		await p.getByRole('button', { name: '저장 중…', exact: true }).waitFor();
		policies.get(p).accept = true;
		const leaving = p.waitForEvent('dialog');
		await p.getByRole('link', { name: sibling.title + ' ↗', exact: true }).click();
		await leaving;
		await p.waitForURL(base + '/drafts?open=' + sibling.id);
		policies.get(p).accept = false;
		assert.equal(await body(p).isEnabled(), true);
		assert.equal(await body(p).inputValue(), sibling.content);
		await body(p).fill('다른 초안에서 새 입력');
		await choice(p).check();
		await backedUp(p, 'content', '다른 초안에서 새 입력');
		release();
		gate = null;
		assert.equal(await pending, 303);
		assert.equal(p.url(), base + '/drafts?open=' + sibling.id);
		assert.equal(await body(p).inputValue(), '다른 초안에서 새 입력');
		assert.equal(
			(await sql`SELECT content FROM drafts WHERE id=${draft.id}`)[0].content,
			'첫 초안 저장 대기'
		);
		await c.close();
		reports.push({
			navigationDuringSave:
				'late response cannot reset a different draft; new input remains enabled and recoverable; original authorized save completes'
		});
	}
	// A failed load still offers local recovery, with no mutation permitted.
	{
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		await open(p, draft.id);
		await body(p).fill('조회 실패 때 복사');
		await choice(p).check();
		await backedUp(p, 'content', '조회 실패 때 복사');
		await sql`ALTER TABLE drafts RENAME TO recovery_unavailable_drafts`;
		try {
			await reload(p);
			await p.getByRole('alert').filter({ hasText: '초안을 불러오지 못했습니다.' }).waitFor();
			await recover(p);
			assert.equal(await body(p).inputValue(), '조회 실패 때 복사');
			await p
				.getByText(
					'초안의 현재 상태를 확인할 수 없습니다. 복구한 입력을 복사해 보관하고 다시 불러와 주세요.',
					{ exact: true }
				)
				.waitFor();
			assert.equal(
				await p
					.getByText('선택한 초안이 없거나 이미 게시·삭제되었습니다.', { exact: true })
					.count(),
				0
			);
			assert.equal(await save(p).isDisabled(), true);
			await shot(p, 'load-error-768-dark');
		} finally {
			await sql`ALTER TABLE recovery_unavailable_drafts RENAME TO drafts`;
			await c.close();
		}
		reports.push({
			loadFailure:
				'actual missing DB relation displays safe error and local recovery; server mutations remain unavailable'
		});
	}
	// Final merge input survives a real transaction failure and retry without duplicate revision.
	{
		const { draft, doc } = await seed(),
			c = await context(),
			p = await page(c);
		await proposed(p, draft);
		await finalBody(p).fill('실패 후 재시도할 최종 본문');
		await choice(p).check();
		await backedUp(p, 'finalContent', '실패 후 재시도할 최종 본문');
		await sql`CREATE FUNCTION recovery_revision_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-final-failure'; END $$`;
		await sql`CREATE TRIGGER recovery_revision_fail BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION recovery_revision_fail()`;
		try {
			await confirm(p).check();
			assert.equal(await submit(p, apply(p)), 503);
			assert.equal(await finalBody(p).inputValue(), '실패 후 재시도할 최종 본문');
			assert.equal(await confirm(p).isChecked(), false);
			assert.equal((await records(p)).length, 1);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
				doc.content
			);
			assert.equal((await sql`SELECT status FROM drafts WHERE id=${draft.id}`)[0].status, 'review');
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM revisions WHERE document_id=${doc.id}`)[0].n,
				1
			);
			await shot(p, 'merge-db-error-768-dark');
		} finally {
			await sql`DROP TRIGGER recovery_revision_fail ON revisions`;
			await sql`DROP FUNCTION recovery_revision_fail()`;
		}
		state.env.OPENAI_API_KEY = '';
		const calls = mockCalls;
		await confirm(p).check();
		assert.equal(await submit(p, apply(p)), 303);
		assert.equal(mockCalls, calls);
		assert.equal(
			(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
			'실패 후 재시도할 최종 본문'
		);
		assert.equal(
			(await sql`SELECT count(*)::int AS n FROM revisions WHERE document_id=${doc.id}`)[0].n,
			2
		);
		await c.close();
		reports.push({
			mergeFailure:
				'actual revision trigger rolls back all writes; final input and copy preserved; explicit keyless retry commits exactly once'
		});
	}
	{
		const { draft } = await seed(),
			c = await context({ javaScriptEnabled: false }),
			p = await page(c);
		await p.goto(base + '/drafts?open=' + draft.id);
		await body(p).fill('기본 폼 초안 입력');
		await sql`UPDATE drafts SET content='다른 저장본',updated_at=clock_timestamp() WHERE id=${draft.id}`;
		assert.equal(await submit(p), 409);
		assert.equal(await body(p).inputValue(), '기본 폼 초안 입력');
		assert.equal(
			await submit(p, p.getByRole('button', { name: '비교 후 내 수정 내용 저장', exact: true })),
			303
		);
		assert.equal(
			(await sql`SELECT content FROM drafts WHERE id=${draft.id}`)[0].content,
			'기본 폼 초안 입력'
		);
		await c.close();
		reports.push({
			nativeDraft:
				'server-rendered form preserves rejected draft edits and explicit version resolution succeeds'
		});
	}

	// Generation rejection protects the input; service failure is not a positive rejection.
	{
		const { draft } = await seed(),
			c = await context(),
			p = await page(c);
		state.env.OPENAI_API_KEY = 'test-only-key';
		const [other] =
			await sql`INSERT INTO documents(title,slug,content) VALUES('다른 대상','other-target','다른 원문') RETURNING *`;
		await open(p, draft.id);
		await target(p).selectOption({ label: '다른 대상 · /other-target' });
		await choice(p).check();
		const selectedTarget = await target(p).inputValue();
		await backedUp(p, 'target', selectedTarget);
		await reload(p);
		await recover(p);
		assert.equal(await target(p).inputValue(), selectedTarget);
		await stored(p, 2);
		mode = 'unavailable';
		assert.equal(await submit(p, generate(p)), 503);
		assert.equal(await choice(p).isEnabled(), true);
		await stored(p, 2);
		mode = 'reject';
		assert.equal(await submit(p, generate(p)), 400);
		await stored(p, 0);
		assert.equal(await choice(p).isDisabled(), true);
		assert.equal(await body(p).inputValue(), draft.content);
		assert.equal(await target(p).inputValue(), selectedTarget);
		mode = 'normal';
		assert.equal(await submit(p, generate(p)), 303);
		assert.equal(await choice(p).isEnabled(), true);
		assert.equal(await choice(p).isChecked(), false);
		assert.equal(
			(await sql`SELECT governance FROM drafts WHERE id=${draft.id}`)[0].governance.merge.targetId,
			String(other.id)
		);
		await finalBody(p).fill('검사 성공 후 새 입력');
		await cancelNavigation(p);
		await choice(p).check();
		await backedUp(p, 'finalContent', '검사 성공 후 새 입력');
		await c.close();
		reports.push({
			generation:
				'selected target preserved; unavailable inspection keeps backup; actual rejection purges all matching copies; successful inspection re-enables opt-in'
		});
	}

	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/draft-browser-results.json',
		JSON.stringify({ reports, externalAttempts, mockedOpenAI: true, pageErrors }, null, 2)
	);
	console.log(
		JSON.stringify({ reports, externalAttempts, mockedOpenAI: true, pageErrors, output }, null, 2)
	);
} finally {
	await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
