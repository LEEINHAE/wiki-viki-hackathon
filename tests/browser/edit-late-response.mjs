import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { recoveryPrefix } from '../../src/lib/edit-recovery.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.LATE_EDIT_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-edit-late-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	port = 4176,
	base = `http://127.0.0.1:${port}`;
// The fixture rejects remote/non-test databases and requires explicit RUN_GOVERNANCE_DB_TESTS=1.
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
const originalFetch = globalThis.fetch;
let externalAttempts = 0,
	browserExternalAttempts = 0;
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
	await c.route('**/*', (route) => {
		if (new URL(route.request().url()).origin === base) return route.continue();
		browserExternalAttempts++;
		return route.abort();
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
async function shot(p, name) {
	await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
	await p.screenshot({ path: output + '/' + name + '.png', fullPage: true });
}
async function reload(p) {
	policies.get(p).accept = true;
	await p.reload({ waitUntil: 'networkidle' });
	policies.get(p).accept = false;
}

async function navigateEditor(p, slug) {
	await p.evaluate((slug) => {
		document.querySelector('#next-editor-test')?.remove();
		const a = document.createElement('a');
		a.id = 'next-editor-test';
		a.href = '/edit/' + slug;
		a.textContent = '다른 편집 화면';
		document.querySelector('main').append(a);
	}, slug);
	policies.get(p).accept = true;
	await p.getByRole('link', { name: '다른 편집 화면', exact: true }).click();
	await p.waitForURL(base + '/edit/' + slug);
	policies.get(p).accept = false;
	await p
		.getByRole('heading', {
			name: `문서 편집: ${slug === 'other-check' ? '다른 문서' : '검증 문서'}`,
			exact: true
		})
		.waitFor();
}
async function holdAction(p, slug) {
	let release, reached, delivered;
	const gate = new Promise((resolve) => (release = resolve)),
		started = new Promise((resolve) => (reached = resolve)),
		completed = new Promise((resolve) => (delivered = resolve));
	const pattern = (url) => url.pathname === '/edit/' + slug && url.search.startsWith('?/');
	let actionStatus,
		routeError,
		intercepted = false;
	await p.route(pattern, async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		intercepted = true;
		try {
			const response = await route.fetch();
			actionStatus = (await response.json()).status;
			reached();
			await gate;
			await route.fulfill({ response });
		} catch (error) {
			routeError = error;
		} finally {
			reached();
			delivered();
		}
	});
	return {
		started: async () => {
			let timer;
			try {
				await Promise.race([
					started,
					new Promise((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('Action response was not intercepted')),
							30000
						);
					})
				]);
				if (routeError) throw routeError;
			} finally {
				clearTimeout(timer);
			}
		},
		release: async () => {
			release();
			if (intercepted) await completed;
			if (routeError) throw routeError;
			await delay(200);
		},
		status: () => actionStatus
	};
}
async function backedUp(p, slug, content) {
	await p.waitForFunction(
		({ prefix, slug, content }) =>
			Object.keys(localStorage)
				.filter((key) => key.startsWith(prefix))
				.some((key) => {
					const r = JSON.parse(localStorage.getItem(key));
					return r.scope === slug && r.values.content === content;
				}),
		{ prefix: recoveryPrefix, slug, content }
	);
}
let pending = [];
try {
	for (const scenario of ['two-saves', 'return-visit', 'late-failure', 'unmounted', 'late-trash']) {
		console.log('Scenario:', scenario);
		const doc = await seed();
		const [other] =
			await sql`INSERT INTO documents(title,slug,content) VALUES('다른 문서','other-check','다른 저장본') RETURNING *`;
		await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${other.id},${other.content},'Editor-01')`;
		const c = await context({ viewport: { width: 1440, height: 1000 } }),
			p = await page(c);
		await open(p);
		const oldVersion = await p.locator('[name="version"]').inputValue();
		await body(p).fill('먼저 제출한 입력');
		await choice(p).check();
		await backedUp(p, doc.slug, '먼저 제출한 입력');
		if (scenario === 'late-failure') {
			await sql`CREATE FUNCTION fail_old_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content='먼저 제출한 입력' THEN RAISE EXCEPTION 'synthetic old transaction failure'; END IF; RETURN NEW; END $$`;
			await sql`CREATE TRIGGER fail_old_save BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION fail_old_save()`;
		}
		const first = await holdAction(p, doc.slug);
		pending.push(first);
		if (scenario === 'late-trash') {
			await p.locator('[name="confirmDelete"]').check();
			await p.getByRole('button', { name: '휴지통으로 이동', exact: true }).click();
		} else await save(p).click();
		await first.started();
		assert.equal(await body(p).isDisabled(), true);
		if (scenario === 'unmounted') {
			policies.get(p).accept = true;
			await p.getByRole('link', { name: '검색', exact: true }).click();
			await p.waitForURL(base + '/?view=search#wiki-search');
			policies.get(p).accept = false;
			const url = p.url(),
				dialogs = policies.get(p).dialogs.length;
			await first.release();
			pending = pending.filter((x) => x !== first);
			assert.equal(p.url(), url, 'late redirect must not leave the page chosen by the user');
			assert.equal(policies.get(p).dialogs.length, dialogs);
		} else {
			await navigateEditor(p, other.slug);
			assert.equal(
				await body(p).isEnabled(),
				true,
				'next document must be editable while the previous response is pending'
			);
			assert.equal(await body(p).inputValue(), other.content);
			if (['return-visit', 'late-failure'].includes(scenario)) await navigateEditor(p, doc.slug);
			const currentSlug = ['return-visit', 'late-failure'].includes(scenario)
				? doc.slug
				: other.slug;
			const currentVersion = await p.locator('[name="version"]').inputValue();
			await body(p).fill('현재 화면에서 새로 작성한 입력');
			await choice(p).check();
			await backedUp(p, currentSlug, '현재 화면에서 새로 작성한 입력');
			const dialogs = policies.get(p).dialogs.length;
			let second;
			if (scenario === 'two-saves') {
				second = await holdAction(p, other.slug);
				pending.push(second);
				await save(p).click();
				await second.started();
			}
			const copies = await records(p);
			await first.release();
			pending = pending.filter((x) => x !== first);
			assert.equal(p.url(), base + '/edit/' + currentSlug);
			assert.equal(await body(p).inputValue(), '현재 화면에서 새로 작성한 입력');
			assert.equal(await p.locator('[name="version"]').inputValue(), currentVersion);
			assert.equal(
				policies.get(p).dialogs.length,
				dialogs,
				'no unexpected navigation prompt from the previous save'
			);
			assert.equal(
				await body(p).isDisabled(),
				scenario === 'two-saves',
				'late finally must not unlock another pending save'
			);
			assert.deepEqual(await records(p), copies);
			if (scenario === 'late-failure') assert.equal(await p.getByRole('alert').count(), 0);
			await shot(p, scenario);
			if (second) {
				await second.release();
				pending = pending.filter((x) => x !== second);
				await p.waitForURL(base + '/wiki/' + other.slug);
				const saved = (await sql`SELECT content FROM documents WHERE id=${other.id}`)[0].content;
				assert.equal(saved, '현재 화면에서 새로 작성한 입력');
				assert.equal((await records(p)).filter((record) => record.scope === other.slug).length, 0);
			} else {
				await reload(p);
				await restore(p).first().click();
				assert.equal(await body(p).inputValue(), '현재 화면에서 새로 작성한 입력');
			}
		}
		assert.equal(first.status(), scenario === 'late-failure' ? 500 : 303);
		const current = (await sql`SELECT * FROM documents WHERE id=${doc.id}`)[0];
		assert.equal(
			current.content,
			['late-failure', 'late-trash'].includes(scenario) ? doc.content : '먼저 제출한 입력'
		);
		assert.equal(!!current.deleted_at, scenario === 'late-trash');
		const revisions =
			await sql`SELECT content,summary FROM revisions WHERE document_id=${doc.id} ORDER BY id`;
		assert.deepEqual(revisions[0], { content: doc.content, summary: '원본' });
		assert.equal(revisions.length, ['late-failure', 'late-trash'].includes(scenario) ? 1 : 2);
		const original = (await records(p)).find(
			(record) => record.scope === doc.slug && record.values.content === '먼저 제출한 입력'
		);
		assert.ok(original, 'leaving an editor keeps its recovery copy for explicit review');
		assert.equal(original.values.version, oldVersion);
		assert.equal(
			(await sql`SELECT count(*)::int n FROM redirects WHERE document_id=${doc.id}`)[0].n,
			1
		);
		if (scenario === 'late-failure') {
			await sql`DROP TRIGGER fail_old_save ON revisions`;
			await sql`DROP FUNCTION fail_old_save()`;
		}
		await c.close();
		reports.push({
			scenario,
			lateResponseIgnored: true,
			currentInputAndVersionPreserved: true,
			originalTransactionVerified: true
		});
	}
	assert.deepEqual(pageErrors, []);
	assert.equal(externalAttempts, 0);
	assert.equal(browserExternalAttempts, 0);
	await writeFile(
		output + '/late-edit-results.json',
		JSON.stringify({ reports, pageErrors, externalAttempts, browserExternalAttempts }, null, 2)
	);
	console.log(
		JSON.stringify(
			{ reports, pageErrors, externalAttempts, browserExternalAttempts, output },
			null,
			2
		)
	);
} finally {
	for (const request of pending) await request.release();
	await browser.close();
	await state.closeDatabase();
	await server.close();
}
