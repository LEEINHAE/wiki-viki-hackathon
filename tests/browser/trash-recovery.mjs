import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { repairTrashSchema } from '../../scripts/lib/trash-schema.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output =
	process.env.TRASH_BROWSER_OUTPUT || (await mkdtemp(resolve(tmpdir(), 'wiki-trash-recovery-')));
const fixture = root + '/tests/fixtures/governance-database.js',
	port = 4183,
	base = `http://127.0.0.1:${port}`;
process.env.OPENAI_API_KEY = '';
process.env.DATABASE_URL = '';
let externalAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
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
			name: 'isolated-trash-browser',
			enforce: 'pre',
			resolveId(id) {
				if ([root + '/src/lib/server/db.js', '$lib/server/db.js', './db.js'].includes(id))
					return fixture;
			}
		}
	]
});
const state = await server.ssrLoadModule(fixture);
let browser;
const reports = [],
	errors = [];
try {
	// Like Neon HTTP, avoid persistent prepared plans while exercising live DDL.
	await state.setupDatabase({ maxConnections: 8, prepare: false });
	state.env.OPENAI_API_KEY = '';
	const sql = state.db();
	await server.listen();
	browser = await chromium.launch({ channel: 'chrome', headless: true });
	async function snapshot() {
		return (
			await sql`SELECT jsonb_build_object(
   'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
   'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
   'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
   'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
   'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
		)[0].data;
	}
	function preserved(before, after, id) {
		for (const key of ['aliases', 'revisions', 'discussions', 'drafts'])
			assert.deepEqual(after[key], before[key]);
		const stable = (rows) =>
			rows.map((row) => {
				const copy = { ...row };
				if (String(copy.id) === String(id))
					for (const key of ['deleted_at', 'deleted_by', 'lifecycle_version']) delete copy[key];
				return copy;
			});
		assert.deepEqual(stable(after.documents), stable(before.documents));
	}
	async function seed(archived = false) {
		await state.clearDatabase();
		const [doc] = await sql`INSERT INTO documents(slug,title,content,editor_handle,updated_at)
   VALUES ('legacy-equipment','장비 점검','## 개요\n\n보관할 점검 본문','Editor-42','2026-09-20 12:34:56.123456+00') RETURNING *`;
		const [other] =
			await sql`INSERT INTO documents(slug,title,content) VALUES ('장비-점검','별도 문서','기존 주소 소유자의 본문') RETURNING *`;
		await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES ('equipment-old','기존 장비',${doc.id}),('other-legacy','장비 점검',${other.id})`;
		await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES (${doc.id},'이전 본문','Editor-01','기존 이력')`;
		await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES (${doc.id},'기존 토론','보존할 의견','Editor-01')`;
		await sql`INSERT INTO drafts(title,slug,content,status,governance) VALUES ('장비 점검','legacy-equipment','게시한 초안','published','{"published":{"slug":"legacy-equipment"}}')`;
		if (archived)
			await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-42',lifecycle_version=1 WHERE id=${doc.id}`;
		return { doc, other };
	}
	async function context(width, theme, javaScriptEnabled = true, deviceScaleFactor = 1) {
		const c = await browser.newContext({
			viewport: { width, height: 950 },
			reducedMotion: 'reduce',
			javaScriptEnabled,
			deviceScaleFactor
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
		p.on('pageerror', (error) => errors.push(error.message));
		return { c, p };
	}
	const restore = (p) => p.getByRole('button', { name: '문서 복구', exact: true });
	async function enter(p, locator) {
		await locator.focus();
		await p.keyboard.press('Enter');
	}
	async function opened(p, path) {
		await p.goto(base + path, { waitUntil: 'networkidle' });
	}
	async function restored(p) {
		await p.waitForURL((url) => decodeURIComponent(url.pathname) === '/wiki/legacy-equipment');
		await p.getByRole('heading', { name: '장비 점검', level: 1, exact: true }).waitFor();
	}
	async function roundtrip(width, theme, javaScriptEnabled = true, deviceScaleFactor = 1) {
		const { doc, other } = await seed(),
			before = await snapshot();
		const { c, p } = await context(width, theme, javaScriptEnabled, deviceScaleFactor);
		try {
			await opened(p, '/edit/equipment-old');
			const confirm = p.getByRole('checkbox', {
				name: '저장된 문서를 휴지통으로 이동하는 것을 확인했습니다.',
				exact: true
			});
			await confirm.focus();
			await p.keyboard.press('Space');
			await enter(p, p.getByRole('button', { name: '휴지통으로 이동', exact: true }));
			await p.waitForURL('**/trash?open=*');
			await restore(p).waitFor();
			assert.equal(await p.getByLabel('보관된 본문', { exact: true }).inputValue(), doc.content);
			assert.equal(await p.locator('.original-address').innerText(), '/wiki/legacy-equipment');
			assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
			const file = `${width}-${theme}-${javaScriptEnabled ? 'js' : 'native'}`;
			await p.screenshot({ path: output + '/archive-' + file + '.png', fullPage: true });
			if (javaScriptEnabled) {
				const gate = Promise.withResolvers();
				await p.route(
					(url) => url.pathname === '/trash' && url.search.startsWith('?/'),
					async (route) => {
						if (route.request().method() === 'POST') await gate.promise;
						await route.continue();
					}
				);
				try {
					await enter(p, restore(p));
					const busy = p.getByRole('button', { name: '복구 중…', exact: true });
					await busy.waitFor();
					assert.equal(await busy.isDisabled(), true);
				} finally {
					gate.resolve();
				}
			} else await enter(p, restore(p));
			await restored(p);
			const after = await snapshot();
			preserved(before, after, doc.id);
			assert.equal(
				after.documents.find((d) => String(d.id) === String(doc.id)).lifecycle_version,
				2
			);
			await p.screenshot({ path: output + '/restored-' + file + '.png', fullPage: true });
			await opened(p, '/wiki/equipment-old');
			await p.getByRole('heading', { name: doc.title, level: 1, exact: true }).waitFor();
			await opened(p, '/wiki/' + encodeURIComponent(other.slug));
			await p.getByRole('heading', { name: other.title, level: 1, exact: true }).waitFor();
			await opened(p, '/trash');
			await p.getByText('휴지통이 비어 있습니다.', { exact: true }).waitFor();
			reports.push({
				width,
				theme,
				javaScriptEnabled,
				deviceScaleFactor,
				roundtrip: 'original URLs, duplicate labels and all relationships preserved',
				empty: true
			});
		} finally {
			await c.close();
		}
	}
	for (const width of [360, 768, 1440])
		for (const theme of ['light', 'dark']) await roundtrip(width, theme);
	for (const theme of ['light', 'dark']) await roundtrip(720, theme, true, 2);
	await roundtrip(768, 'light', false);
	const { c, p } = await context(360, 'dark');
	try {
		let { doc, other } = await seed(true);
		await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES ('legacy-equipment','실제 주소 충돌',${other.id})`;
		await opened(p, '/trash?open=' + doc.id);
		let before = await snapshot();
		await enter(p, restore(p));
		await p.getByRole('alert').filter({ hasText: '사용하고 있어 복구하지 않았습니다.' }).waitFor();
		assert.deepEqual(await snapshot(), before);
		assert.equal(await restore(p).isEnabled(), true);
		await p.screenshot({ path: output + '/actual-conflict-360-dark.png', fullPage: true });
		await sql`DELETE FROM redirects WHERE alias_slug='legacy-equipment'`;
		before = await snapshot();
		await enter(p, restore(p));
		await restored(p);
		preserved(before, await snapshot(), doc.id);
		reports.push({
			actualRouteConflict: '409 leaves rows unchanged; retry restores after conflict removal'
		});

		({ doc } = await seed(true));
		await opened(p, '/trash?open=' + doc.id);
		await sql`UPDATE redirects SET alias_title='바뀐 보관 별칭' WHERE document_id=${doc.id}`;
		before = await snapshot();
		await enter(p, restore(p));
		await p
			.getByRole('alert')
			.filter({ hasText: '상태가 변경되어 복구하지 않았습니다.' })
			.waitFor();
		assert.equal(await restore(p).isDisabled(), true);
		assert.deepEqual(await snapshot(), before);
		await enter(p, p.getByRole('link', { name: '최신 휴지통 다시 열기', exact: true }));
		await p.getByText('보관한 별칭: 바뀐 보관 별칭', { exact: true }).waitFor();
		await enter(p, restore(p));
		await restored(p);
		preserved(before, await snapshot(), doc.id);
		reports.push({
			staleReview: '409 preserves archive, requires explicit reload before successful retry'
		});

		({ doc } = await seed(true));
		await opened(p, '/trash?open=' + doc.id);
		before = await snapshot();
		await sql`CREATE FUNCTION fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-private-restore-error'; END $$`;
		await sql`CREATE TRIGGER fail_restore BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION fail_restore()`;
		try {
			await enter(p, restore(p));
			await p.getByRole('alert').filter({ hasText: '복구 결과를 확인하지 못했습니다.' }).waitFor();
			assert.deepEqual(await snapshot(), before);
			assert.equal(await restore(p).isEnabled(), true);
			assert.doesNotMatch(await p.locator('body').innerText(), /test-private/);
			await p.screenshot({ path: output + '/restore-error-360-dark.png', fullPage: true });
		} finally {
			await sql`DROP TRIGGER fail_restore ON documents`;
			await sql`DROP FUNCTION fail_restore()`;
		}
		await enter(p, restore(p));
		await restored(p);
		preserved(before, await snapshot(), doc.id);
		reports.push({
			databaseFailure: 'real failed UPDATE rolls back, safe error and retry succeeds'
		});
	} finally {
		await c.close();
	}
	for (const [width, theme] of [
		[360, 'light'],
		[1440, 'dark']
	]) {
		const { doc } = await seed();
		const { c, p } = await context(width, theme);
		try {
			await sql`ALTER TABLE documents DROP COLUMN lifecycle_version`;
			await opened(p, '/edit/equipment-old');
			await p.getByLabel('문서 제목', { exact: true }).fill('작성 중인 제목 유지');
			await p
				.getByRole('checkbox', {
					name: '저장된 문서를 휴지통으로 이동하는 것을 확인했습니다.',
					exact: true
				})
				.check();
			let before = await snapshot();
			await enter(p, p.getByRole('button', { name: '휴지통으로 이동', exact: true }));
			await p
				.getByRole('alert')
				.filter({ hasText: '서버 업데이트가 적용되지 않아 이동하지 않았습니다.' })
				.waitFor();
			assert.equal(
				await p.getByLabel('문서 제목', { exact: true }).inputValue(),
				'작성 중인 제목 유지'
			);
			assert.deepEqual(await snapshot(), before);
			assert.doesNotMatch(await p.locator('body').innerText(), /lifecycle_version|42703/);
			await p.screenshot({ path: output + `/schema-delete-${width}-${theme}.png`, fullPage: true });
			await repairTrashSchema({ sql, apply: true });
			for (const row of before.documents) row.lifecycle_version = 0;
			assert.deepEqual(await snapshot(), before);
			await opened(p, '/edit/equipment-old');
			await p
				.getByRole('checkbox', {
					name: '저장된 문서를 휴지통으로 이동하는 것을 확인했습니다.',
					exact: true
				})
				.check();
			await enter(p, p.getByRole('button', { name: '휴지통으로 이동', exact: true }));
			await p.waitForURL('**/trash?open=*');
			preserved(before, await snapshot(), doc.id);
			await sql`ALTER TABLE documents DROP COLUMN lifecycle_version`;
			await opened(p, '/trash?open=' + doc.id);
			before = await snapshot();
			await enter(p, restore(p));
			await p
				.getByRole('alert')
				.filter({ hasText: '서버 업데이트가 적용되지 않아 복구하지 않았습니다.' })
				.waitFor();
			assert.deepEqual(await snapshot(), before);
			await p.screenshot({
				path: output + `/schema-restore-${width}-${theme}.png`,
				fullPage: true
			});
			await repairTrashSchema({ sql, apply: true });
			for (const row of before.documents) row.lifecycle_version = 0;
			assert.deepEqual(await snapshot(), before);
			await opened(p, '/trash?open=' + doc.id);
			await enter(p, restore(p));
			await restored(p);
			preserved(before, await snapshot(), doc.id);
			reports.push({
				width,
				theme,
				legacySchema:
					'503 preserves inputs/archive; repair and reload allow deletion and restoration'
			});
		} finally {
			await c.close();
		}
	}
	assert.deepEqual(errors, []);
	assert.equal(externalAttempts, 0);
	await writeFile(
		output + '/results.json',
		JSON.stringify({ reports, errors, externalAttempts }, null, 2)
	);
	console.log(JSON.stringify({ output, reports, errors, externalAttempts }, null, 2));
} finally {
	if (browser) await browser.close();
	await state.closeDatabase();
	await server.close();
	globalThis.fetch = originalFetch;
}
