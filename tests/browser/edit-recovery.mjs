import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { recoveryPrefix, recoveryLifetime } from '../../src/lib/edit-recovery.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.RECOVERY_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-edit-recovery-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	port = 4188,
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
							text: JSON.stringify({
								passed: mode !== 'reject',
								reasons: mode === 'reject' ? ['보호 검사 거부'] : []
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
	save = (p) => p.getByRole('button', { name: '문서 저장', exact: true });
async function seed() {
	await state.clearDatabase();
	state.env.OPENAI_API_KEY = '';
	mode = 'normal';
	gate = null;
	const [doc] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('검증 문서','recovery-check','저장된 본문') RETURNING *`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('기존-별칭','기존 별칭',${doc.id})`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${doc.id},${doc.content},'Editor-01','원본')`;
	return doc;
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
	return p;
}
async function open(p, slug = 'recovery-check', theme = 'dark') {
	await p.goto(base + '/edit/' + encodeURIComponent(slug), { waitUntil: 'networkidle' });
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
		(r) => r.request().method() === 'POST' && r.url().includes('/edit/')
	);
	await button.focus();
	await p.keyboard.press('Enter');
	const r = await response,
		payload = r.headers()['content-type']?.includes('application/json') ? await r.json() : null;
	await p.waitForLoadState('networkidle');
	await p.locator('form.wiki-form[aria-busy="true"]').waitFor({ state: 'detached' });
	return payload?.status ?? r.status();
}
async function cancelNavigation(p) {
	const dialog = p.waitForEvent('dialog');
	await p.getByRole('link', { name: '취소', exact: true }).click();
	await dialog;
}
async function reload(p) {
	policies.get(p).accept = true;
	await p.reload({ waitUntil: 'networkidle' });
	policies.get(p).accept = false;
}
async function nameConflicts(width, theme, javaScriptEnabled = true) {
	const doc = await seed();
	const [other] =
		await sql`INSERT INTO documents(title,slug,content) VALUES('다른 제목','other-preserved','다른 원문') RETURNING *`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('legacy-other-label','다른 별칭',${other.id})`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${other.id},${other.content},'Editor-01')`;
	const snapshot = async () =>
		(
			await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r)) data`
		)[0].data;
	const before = await snapshot(),
		c = await context({ viewport: { width, height: 950 }, javaScriptEnabled }),
		p = await page(c);
	await open(p, '기존-별칭', javaScriptEnabled ? theme : 'dark');
	const version = await p.locator('[name="version"]').inputValue();
	const inputs = {
		title: doc.title,
		content: '이름 충돌 후에도 보존할 본문\n둘째 줄',
		aliases: '기존 별칭',
		editor: 'Editor-77',
		summary: '충돌 후 수정'
	};
	for (const [name, value] of Object.entries(inputs))
		await p.locator(`[name="${name}"]`).fill(value);
	for (const conflict of [
		{ title: '다른 별칭' },
		{ aliases: '다른 제목' },
		{ aliases: '다른 별칭' }
	]) {
		const expected = { ...inputs, ...conflict };
		await p.locator('[name="title"]').fill(expected.title);
		await p.locator('[name="aliases"]').fill(expected.aliases);
		assert.equal(await submit(p), 409);
		await p
			.getByRole('alert')
			.filter({ hasText: '다른 문서가 같은 제목·주소·별칭을 사용하고 있습니다.' })
			.waitFor();
		for (const [name, value] of Object.entries(expected))
			assert.equal(await p.locator(`[name="${name}"]`).inputValue(), value);
		assert.equal(await p.locator('[name="version"]').inputValue(), version);
		assert.equal(await p.locator('[name="documentId"]').inputValue(), String(doc.id));
		assert.deepEqual(await snapshot(), before);
	}
	assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await shot(p, `name-conflict-${width}-${theme}`);
	await p.locator('[name="title"]').fill(inputs.title);
	await p.locator('[name="aliases"]').fill('기존 별칭\n새 안전한 별칭');
	assert.equal(await submit(p), 303);
	await p.waitForURL(base + '/wiki/' + doc.slug);
	const after = await snapshot(),
		saved = after.documents.find((d) => String(d.id) === String(doc.id));
	assert.equal(saved.slug, doc.slug);
	assert.equal(
		saved.content,
		javaScriptEnabled ? inputs.content : inputs.content.replaceAll('\n', '\r\n')
	);
	assert.deepEqual(
		after.documents.find((d) => String(d.id) === String(other.id)),
		before.documents.find((d) => String(d.id) === String(other.id))
	);
	assert.deepEqual(after.revisions.slice(0, before.revisions.length), before.revisions);
	assert.equal(after.revisions.length, before.revisions.length + 1);
	for (const alias of before.aliases)
		assert.deepEqual(
			after.aliases.find((a) => String(a.id) === String(alias.id)),
			alias
		);
	assert.equal(after.aliases.length, before.aliases.length + 1);
	await c.close();
	reports.push({
		width,
		theme,
		javaScriptEnabled,
		nameConflicts:
			'three legacy label collisions return 409 with unchanged data and input; correcting the name saves once via the original document URL'
	});
}
async function legacyTitleRoutes(width, theme, javaScriptEnabled = true) {
	const doc = await seed();
	const [other] = await sql`INSERT INTO documents(title,slug,content)
		VALUES ('별도 주소 소유자',${javaScriptEnabled ? '검증-문서' : 'other-owner'},'다른 문서의 보존 본문') RETURNING *`;
	if (!javaScriptEnabled)
		await sql`INSERT INTO redirects(alias_slug,alias_title,document_id)
		VALUES ('검증-문서','다른 문서의 옛 주소',${other.id})`;
	await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle)
		VALUES (${doc.id},'보존 토론','기존 의견','Editor-01')`;
	await sql`INSERT INTO drafts(title,slug,content,status,governance)
		VALUES (${doc.title},${doc.slug},'보존할 게시 초안','published',${JSON.stringify({ published: { slug: doc.slug } })}::jsonb)`;
	const snapshot = async () =>
		(
			await sql`SELECT jsonb_build_object(
		'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
		'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
		'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
		'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
		'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
		)[0].data;
	const before = await snapshot(),
		c = await context({ viewport: { width, height: 950 }, javaScriptEnabled }),
		p = await page(c);
	function preserved(after) {
		for (const key of ['aliases', 'discussions', 'drafts'])
			assert.deepEqual(after[key], before[key]);
		assert.deepEqual(
			after.documents.find((d) => String(d.id) === String(other.id)),
			before.documents.find((d) => String(d.id) === String(other.id))
		);
		const saved = after.documents.find((d) => String(d.id) === String(doc.id));
		for (const key of ['id', 'slug', 'title', 'created_at'])
			assert.equal(saved[key], before.documents[0][key]);
		return saved;
	}
	try {
		await open(p, '기존-별칭', javaScriptEnabled ? theme : 'dark');
		const content = '기존 제목과 주소를 유지한 수정 본문';
		await body(p).fill(content);
		assert.equal(await submit(p), 303);
		await p.waitForURL(base + '/wiki/' + doc.slug);
		await p.getByText(content, { exact: true }).waitFor();
		let after = await snapshot();
		assert.equal(preserved(after).content, content);
		assert.deepEqual(after.revisions.slice(0, before.revisions.length), before.revisions);
		assert.equal(after.revisions.length, before.revisions.length + 1);
		await shot(p, `legacy-title-saved-${width}-${theme}`);
		const savedRevisions = after.revisions;
		await p.goto(base + '/history/' + doc.slug, { waitUntil: 'networkidle' });
		const button = p.getByRole('button', {
			name: `리비전 ${before.revisions[0].id}로 되돌리기`,
			exact: true
		});
		const response = p.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/history/')
		);
		await button.focus();
		await p.keyboard.press('Enter');
		const r = await response;
		assert.equal(
			r.headers()['content-type']?.includes('application/json')
				? (await r.json()).status
				: r.status(),
			303
		);
		await p.waitForURL(base + '/wiki/' + doc.slug);
		await p.getByText(doc.content, { exact: true }).waitFor();
		after = await snapshot();
		assert.equal(preserved(after).content, doc.content);
		assert.deepEqual(after.revisions.slice(0, savedRevisions.length), savedRevisions);
		assert.equal(after.revisions.length, savedRevisions.length + 1);
		assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
		await shot(p, `legacy-title-rollback-${width}-${theme}`);
		await p.goto(base + '/wiki/' + encodeURIComponent('기존-별칭'), { waitUntil: 'networkidle' });
		await p.getByRole('heading', { name: doc.title, level: 1, exact: true }).waitFor();
		await p.goto(base + '/wiki/' + encodeURIComponent('검증-문서'), { waitUntil: 'networkidle' });
		await p.getByRole('heading', { name: other.title, level: 1, exact: true }).waitFor();
		reports.push({
			width,
			theme,
			javaScriptEnabled,
			legacyTitleRoutes:
				'keyboard edit and rollback preserve the original title/URL, aliases, old revisions, discussions, published draft and foreign URL owner'
		});
	} finally {
		await c.close();
	}
}
try {
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) await legacyTitleRoutes(width, theme);
	await legacyTitleRoutes(768, 'native', false);
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) await nameConflicts(width, theme);
	await nameConflicts(768, 'native', false);
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) {
			const doc = await seed(),
				c = await context({ viewport: { width, height: 950 } }),
				p = await page(c);
			await open(p, doc.slug, theme);
			assert.equal(await choice(p).isChecked(), false);
			await p.getByText('이 주소에서 복구할 이전 입력이 없습니다.', { exact: true }).waitFor();
			await shot(p, `empty-${width}-${theme}`);
			const originalVersion = await p.locator('[name="version"]').inputValue();
			const inputs = {
				title: '검증 문서 수정',
				content: '작성 중 본문\n\n[[기존 별칭]]\n\n마지막 줄',
				aliases: '쉼표, 별칭\n추가 별칭',
				editor: 'Editor-77',
				summary: '보존할 편집 요약'
			};
			for (const [name, value] of Object.entries(inputs))
				await p.locator(`[name="${name}"]`).fill(value);
			await delay(500);
			assert.equal((await records(p)).length, 0);
			const callsBefore = mockCalls;
			await cancelNavigation(p);
			assert.match(p.url(), /\/edit\//);
			assert.equal(policies.get(p).dialogs.at(-1), 'confirm');
			assert.equal(await body(p).inputValue(), inputs.content);
			await choice(p).focus();
			await p.keyboard.press('Space');
			await stored(p);
			assert.equal(mockCalls, callsBefore);
			const saved = (await records(p))[0];
			for (const [name, value] of Object.entries(inputs)) assert.equal(saved.values[name], value);
			assert.equal(saved.values.version, originalVersion);
			assert.equal(saved.values.documentId, String(doc.id));
			await reload(p);
			assert.equal(policies.get(p).dialogs.at(-1), 'beforeunload');
			assert.equal(await body(p).inputValue(), doc.content);
			assert.equal(await choice(p).isChecked(), false);
			await restore(p).focus();
			await p.keyboard.press('Enter');
			await stored(p, 2);
			for (const [name, value] of Object.entries(inputs))
				assert.equal(await p.locator(`[name="${name}"]`).inputValue(), value);
			assert.equal(await p.locator('[name="version"]').inputValue(), originalVersion);
			if (theme === 'light')
				await p.getByRole('button', { name: '라이트 모드로 전환', exact: true }).click();
			assert.equal(await p.locator('html').getAttribute('data-theme'), theme);
			await shot(p, `restored-${width}-${theme}`);
			assert.equal(
				await p.evaluate(
					() => document.documentElement.scrollWidth > document.documentElement.clientWidth
				),
				false
			);
			await choice(p).uncheck();
			await stored(p);
			assert.equal((await records(p))[0].id, saved.id);
			await choice(p).check();
			await stored(p, 2);
			const dialogsBefore = policies.get(p).dialogs.length;
			await submit(p);
			await p.getByRole('heading', { name: inputs.title, exact: true }).waitFor();
			assert.equal(policies.get(p).dialogs.length, dialogsBefore);
			assert.equal((await records(p)).length, 1);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
				inputs.content
			);
			reports.push({
				width,
				theme,
				defaultOff: true,
				SPAWarning: true,
				reloadWarning: true,
				allFieldsRestored: true,
				originalVersion: true,
				keyboard: true,
				overflow: false,
				successClearsOnlyCurrent: true
			});
			await c.close();
		}
	// A restored stale token must fail before AI; explicit comparison is required.
	let doc = await seed();
	let c = await context(),
		p = await page(c);
	await open(p);
	await body(p).fill('보존할 내 변경');
	await choice(p).check();
	await stored(p);
	const version = (await records(p))[0].values.version;
	await sql`UPDATE documents SET content='다른 편집자의 변경',updated_at=clock_timestamp() WHERE id=${doc.id}`;
	await reload(p);
	await restore(p).click();
	await stored(p, 2);
	state.env.OPENAI_API_KEY = 'test-only-key';
	const callsBefore = mockCalls;
	assert.equal(await submit(p), 409);
	assert.equal(mockCalls, callsBefore);
	assert.equal(await body(p).inputValue(), '보존할 내 변경');
	assert.equal(await p.locator('[name="version"]').inputValue(), version);
	assert.equal(
		await p.getByLabel('현재 저장된 본문', { exact: true }).inputValue(),
		'다른 편집자의 변경'
	);
	assert.equal(await save(p).isDisabled(), true);
	await shot(p, 'restored-conflict-768-dark');
	await submit(p, p.getByRole('button', { name: '비교 후 내 수정 내용 저장', exact: true }));
	assert.equal(
		(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
		'보존할 내 변경'
	);
	await c.close();
	reports.push({
		staleRecovery: '409 before AI; original token/input preserved; explicit comparison saves'
	});
	// Failed real transaction and delayed submission retain recovery; retry commits once.
	doc = await seed();
	c = await context({ viewport: { width: 360, height: 950 } });
	p = await page(c);
	await open(p);
	await body(p).fill('실패 후 보존할 내용');
	await choice(p).check();
	await stored(p);
	await sql`CREATE FUNCTION fail_recovery_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-recovery-db'; END $$`;
	await sql`CREATE TRIGGER fail_recovery_revision BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION fail_recovery_revision()`;
	try {
		assert.equal(await submit(p), 500);
		assert.equal(await body(p).inputValue(), '실패 후 보존할 내용');
		assert.equal((await records(p))[0].values.content, '실패 후 보존할 내용');
		assert.equal(
			(await sql`SELECT content FROM documents WHERE id=${doc.id}`)[0].content,
			doc.content
		);
		assert.doesNotMatch(await p.locator('body').innerText(), /private-recovery-db/);
		await shot(p, 'database-error-360-dark');
	} finally {
		await sql`DROP TRIGGER fail_recovery_revision ON revisions`;
		await sql`DROP FUNCTION fail_recovery_revision()`;
	}
	state.env.OPENAI_API_KEY = 'test-only-key';
	let release;
	gate = new Promise((r) => (release = r));
	const pending = submit(p);
	await p.getByRole('button', { name: '저장 중…', exact: true }).waitFor();
	assert.equal(await choice(p).isDisabled(), true);
	assert.equal(await body(p).isDisabled(), true);
	await shot(p, 'saving-360-dark');
	release();
	gate = null;
	await pending;
	await stored(p, 0);
	assert.equal((await sql`SELECT id FROM revisions`).length, 2);
	await c.close();
	reports.push({
		transaction:
			'real revision failure rolls back; input and recovery retained; delayed retry locks editing and saves once'
	});
	// Simultaneous pages keep independent records; deletion elsewhere stops resurrection.
	await seed();
	c = await context();
	p = await page(c);
	const q = await page(c);
	await open(p);
	await open(q);
	await body(p).fill('첫 탭 입력');
	await choice(p).check();
	await stored(p);
	await body(q).fill('두 번째 탭 입력');
	await choice(q).check();
	await stored(q, 2);
	assert.deepEqual((await records(q)).map((r) => r.values.content).sort(), [
		'두 번째 탭 입력',
		'첫 탭 입력'
	]);
	await q.getByRole('button', { name: '이 복구본 삭제', exact: true }).click();
	await stored(p);
	await p
		.getByText(
			'다른 탭에서 이 복구본을 삭제해 임시 보관을 중지했습니다. 화면의 입력은 유지했습니다.',
			{ exact: true }
		)
		.waitFor();
	assert.equal(await choice(p).isChecked(), false);
	await body(p).fill('삭제 후 추가 입력');
	await delay(550);
	assert.equal((await records(p)).length, 1);
	assert.equal((await records(p))[0].values.content, '두 번째 탭 입력');
	assert.equal(await body(p).inputValue(), '삭제 후 추가 입력');
	await c.close();
	reports.push({
		tabs: 'independent writes; explicit deletion propagates and disables recreation without losing screen input'
	});
	// Browser persistence denial/quota never promises recovery or discards the previous complete copy.
	await seed();
	c = await context();
	p = await page(c);
	await open(p);
	await body(p).fill('먼저 보관한 입력');
	await choice(p).check();
	await stored(p);
	const original = (await records(p))[0];
	await p.evaluate((prefix) => {
		const set = Storage.prototype.setItem;
		Storage.prototype.setItem = function (k, v) {
			if (k.startsWith(prefix)) throw new DOMException('test quota', 'QuotaExceededError');
			return set.call(this, k, v);
		};
	}, recoveryPrefix);
	await body(p).fill('용량 부족 후 입력');
	await p.getByText('임시 복구본을 보관하거나 읽지 못했습니다.', { exact: false }).waitFor();
	assert.equal((await records(p))[0].values.content, original.values.content);
	assert.equal(await body(p).inputValue(), '용량 부족 후 입력');
	await shot(p, 'quota-error-768-dark');
	await c.close();
	c = await context();
	await c.addInitScript(() =>
		Object.defineProperty(window, 'localStorage', {
			get() {
				throw new DOMException('test denied', 'SecurityError');
			}
		})
	);
	p = await page(c);
	await open(p);
	assert.equal(await choice(p).isDisabled(), true);
	await body(p).fill('접근 차단 환경 입력');
	await cancelNavigation(p);
	assert.match(p.url(), /\/edit\//);
	assert.equal(await body(p).inputValue(), '접근 차단 환경 입력');
	await p.getByText('임시 복구본을 보관하거나 읽지 못했습니다.', { exact: false }).waitFor();
	await c.close();
	reports.push({
		storageFailure:
			'quota keeps previous complete copy and current text; denied access still warns before navigation'
	});
	// Local and semantic rejection remove the active backup; recovery itself sends nothing externally.
	await seed();
	c = await context();
	p = await page(c);
	await open(p);
	await body(p).fill('안전한 중간 입력');
	await choice(p).check();
	await stored(p);
	const before = mockCalls;
	await body(p).fill('900101-1000000 입력');
	await stored(p, 0);
	assert.equal(await choice(p).isDisabled(), true);
	assert.equal(mockCalls, before);
	await cancelNavigation(p);
	assert.match(p.url(), /\/edit\//);
	assert.equal(await body(p).inputValue(), '900101-1000000 입력');
	await shot(p, 'protected-768-dark');
	await body(p).fill('로컬 검사 통과 합성 내용');
	await stored(p);
	state.env.OPENAI_API_KEY = 'test-only-key';
	mode = 'reject';
	await reload(p);
	await restore(p).click();
	await stored(p, 2);
	assert.equal(await submit(p), 400);
	await stored(p, 0);
	assert.equal(await body(p).inputValue(), '로컬 검사 통과 합성 내용');
	assert.equal(await choice(p).isDisabled(), true);
	await p.getByLabel('익명 편집자 이름', { exact: true }).fill('invalid-handle');
	assert.equal(await submit(p), 400);
	await stored(p, 0);
	assert.equal(await choice(p).isDisabled(), true);
	await c.close();
	reports.push({
		protectedInput:
			'local input not stored or sent; semantic rejection clears active copy; screen input and leave warning retained'
	});
	// Expiry, new documents, route navigation, and restoring input for a trashed document.
	await seed();
	c = await context();
	p = await page(c);
	await open(p, 'new-recovery');
	await body(p).fill('새 문서 작성 중');
	await choice(p).check();
	await stored(p);
	assert.equal((await records(p))[0].values.version, 'new');
	assert.equal((await records(p))[0].values.documentId, '');
	await reload(p);
	await restore(p).click();
	assert.equal(await body(p).inputValue(), '새 문서 작성 중');
	await stored(p, 2);
	// A real in-app link uses the client router, so the keyed recovery instance must reset.
	await p.evaluate(() => {
		const a = document.createElement('a');
		a.href = '/edit/recovery-check';
		a.textContent = '다른 편집 화면';
		document.querySelector('.form-page').append(a);
	});
	policies.get(p).accept = true;
	const routeDialog = p.waitForEvent('dialog');
	await p.getByRole('link', { name: '다른 편집 화면', exact: true }).click();
	await routeDialog;
	await p.waitForURL(base + '/edit/recovery-check');
	policies.get(p).accept = false;
	await p.getByRole('heading', { name: '문서 편집: 검증 문서', exact: true }).waitFor();
	assert.equal(await body(p).inputValue(), '저장된 본문');
	assert.equal(await choice(p).isChecked(), false);
	assert.equal(await restore(p).count(), 0);
	assert.equal((await records(p)).length, 2);
	await p.evaluate(
		({ prefix, lifetime }) => {
			for (const k of Object.keys(localStorage).filter((k) => k.startsWith(prefix))) {
				const r = JSON.parse(localStorage.getItem(k));
				r.savedAt = Date.now() - lifetime;
				r.expiresAt = r.savedAt + lifetime;
				localStorage.setItem(k, JSON.stringify(r));
			}
			localStorage.setItem('unrelated-user-work', 'preserve');
		},
		{ prefix: recoveryPrefix, lifetime: recoveryLifetime }
	);
	await reload(p);
	await stored(p, 0);
	assert.equal(await p.evaluate(() => localStorage.getItem('unrelated-user-work')), 'preserve');
	await body(p).fill('삭제 뒤에도 복구할 입력');
	await choice(p).check();
	await stored(p);
	await p.locator('[name="confirmDelete"]').check();
	const deletionDialogs = policies.get(p).dialogs.length;
	await submit(p, p.getByRole('button', { name: '휴지통으로 이동', exact: true }));
	assert.equal(policies.get(p).dialogs.length, deletionDialogs);
	assert.equal((await records(p)).length, 1);
	await open(p);
	await p.getByRole('heading', { name: '휴지통에 있는 문서', exact: true }).waitFor();
	await restore(p).click();
	assert.equal(await body(p).inputValue(), '삭제 뒤에도 복구할 입력');
	assert.equal(await save(p).isDisabled(), true);
	await shot(p, 'trashed-recovery-768-dark');
	await c.close();
	reports.push({
		routes:
			'new version retained; accepted SPA switch resets editor without touching previous route copies; expiry removes only owned records; trash recovery remains copyable but cannot publish'
	});
	// Re-read at restore time: an expired selection cannot replace unsaved screen input.
	await seed();
	c = await context();
	p = await page(c);
	await open(p);
	await body(p).fill('만료될 복구본');
	await choice(p).check();
	await stored(p);
	await reload(p);
	await body(p).fill('유지할 현재 입력');
	await p.evaluate(
		({ prefix, lifetime }) => {
			for (const k of Object.keys(localStorage).filter((k) => k.startsWith(prefix))) {
				const r = JSON.parse(localStorage.getItem(k));
				r.savedAt = Date.now() - lifetime;
				r.expiresAt = r.savedAt + lifetime;
				localStorage.setItem(k, JSON.stringify(r));
			}
		},
		{ prefix: recoveryPrefix, lifetime: recoveryLifetime }
	);
	policies.get(p).accept = true;
	const restoreDialog = p.waitForEvent('dialog');
	await restore(p).click();
	await restoreDialog;
	policies.get(p).accept = false;
	await p
		.getByText('복구본이 만료되었거나 삭제되었습니다. 현재 입력은 바꾸지 않았습니다.', {
			exact: true
		})
		.waitFor();
	assert.equal(await body(p).inputValue(), '유지할 현재 입력');
	await stored(p, 0);
	await p.evaluate(() => {
		const a = document.createElement('a');
		a.href = location.pathname;
		a.dataset.sveltekitReload = '';
		a.textContent = '전체 다시 열기';
		document.querySelector('.form-page').append(a);
	});
	const sameUrlDialog = p.waitForEvent('dialog');
	await p.getByRole('link', { name: '전체 다시 열기', exact: true }).click();
	assert.equal((await sameUrlDialog).type(), 'confirm');
	assert.equal(await body(p).inputValue(), '유지할 현재 입력');
	await c.close();
	reports.push({
		restoreRace: 'expired record rechecked and screen input preserved',
		sameUrlReload: 'confirmation also protects full reload links to the same URL'
	});
	// SSR loading presentation and native forms still preserve values without JavaScript.
	await seed();
	c = await context();
	p = await page(c);
	let allowScript;
	const scriptGate = new Promise((r) => (allowScript = r));
	await p.route('**/*', async (r) => {
		if (r.request().resourceType() === 'script') await scriptGate;
		await r.continue();
	});
	await p.goto(base + '/edit/recovery-check', { waitUntil: 'commit' });
	await p.getByText('임시 복구본을 확인하고 있습니다.', { exact: true }).waitFor();
	assert.equal(await choice(p).isDisabled(), true);
	await shot(p, 'loading-768-before-hydration');
	allowScript();
	await p.waitForLoadState('networkidle');
	await c.close();
	c = await context({ javaScriptEnabled: false });
	p = await page(c);
	await p.goto(base + '/edit/recovery-check');
	assert.equal(await body(p).inputValue(), '저장된 본문');
	assert.equal(await p.locator('.recovery-panel noscript p').isVisible(), true);
	assert.match(
		await p.locator('.recovery-panel noscript p').innerText(),
		/임시 복구와 이동 전 안내에는 JavaScript가 필요합니다/
	);
	await body(p).fill('기본 폼 보존');
	await sql`UPDATE documents SET content='기본 폼 외부 변경',updated_at=clock_timestamp()`;
	assert.equal(await submit(p), 409);
	assert.equal(await body(p).inputValue(), '기본 폼 보존');
	await shot(p, 'native-conflict-768-light');
	await submit(p, p.getByRole('button', { name: '비교 후 내 수정 내용 저장', exact: true }));
	assert.equal((await sql`SELECT content FROM documents`)[0].content, '기본 폼 보존');
	await c.close();
	reports.push({
		noJavaScript: 'SSR values and explicit limitation; conflict retains input; comparison saves',
		loading: 'disabled opt-in before hydration'
	});
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/browser-results.json',
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
