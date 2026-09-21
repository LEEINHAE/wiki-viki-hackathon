import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { slugify } from '../src/lib/knowledge.js';
import * as state from './fixtures/governance-database.js';

test(
	'demo seed preserves existing data through the real CLI and PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1', timeout: 90000 },
	async (t) => {
		await state.setupDatabase();
		const sql = state.db();
		const [{ schema }] = await sql`SELECT current_schema() AS schema`;
		const dir = await mkdtemp(join(tmpdir(), 'wiki-viki-demo-seed-'));
		const connections = [],
			children = [];
		let sequence = 0;
		await mkdir(join(dir, 'scripts'));
		await copyFile(
			new URL('../scripts/seed-demo.js', import.meta.url),
			join(dir, 'scripts/seed-demo.js')
		);
		await symlink(
			fileURLToPath(new URL('../node_modules', import.meta.url)),
			join(dir, 'node_modules')
		);
		await writeFile(join(dir, '.env'), '');
		function launch({ runtime = 'bun', databaseUrl } = {}) {
			const name = `${schema}_demo_${++sequence}`;
			const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
			target.searchParams.set('options', '-c search_path=' + schema);
			target.searchParams.set('application_name', name);
			const child = spawn(
				runtime,
				runtime === 'bun'
					? ['run', '--env-file=./.env', 'scripts/seed-demo.js']
					: ['scripts/seed-demo.js'],
				{
					cwd: dir,
					env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl ?? target.toString() },
					timeout: 20000,
					killSignal: 'SIGKILL'
				}
			);
			children.push(child);
			let stdout = '',
				stderr = '';
			child.stdout.on('data', (chunk) => (stdout += chunk));
			child.stderr.on('data', (chunk) => (stderr += chunk));
			const done = new Promise((resolve, reject) => {
				child.on('error', reject);
				child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
			});
			return { child, name, done };
		}
		const run = (options) => launch(options).done;
		const reset = () => sql`TRUNCATE documents, drafts, announcements RESTART IDENTITY CASCADE`;
		async function snapshot() {
			const [row] = await sql`SELECT jsonb_build_object(
				'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
				'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
				'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
				'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
				'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),
				'announcements',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM announcements a)
			) AS data`;
			return row.data;
		}
		function preserved(before, after) {
			for (const [key, rows] of Object.entries(before))
				for (const row of rows || [])
					assert.deepEqual(
						after[key]?.find((next) => next.id === row.id),
						row,
						`${key} ${row.id} changed`
					);
		}
		function succeeded(result, created, skipped, archived = 0) {
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.signal, null);
			assert.match(
				result.stdout,
				new RegExp(`생성 ${created}개, 기존 데이터 보존으로 건너뜀 ${skipped}개`)
			);
			assert.match(result.stdout, new RegExp(`휴지통 보존으로 건너뜀 ${archived}개`));
		}
		function failed(result) {
			assert.equal(result.code, 1, result.stderr);
			assert.equal(result.signal, null);
			assert.equal(result.stdout, '');
			assert.match(result.stderr, /예시.*(?:완료하지 못했습니다|중단되었습니다)/);
			assert.doesNotMatch(
				result.stderr,
				/test-private|postgres:\/\/|PostgresError|TypeError|at .*\.js/
			);
		}
		async function connect() {
			const connection = postgres(process.env.GOVERNANCE_TEST_DATABASE_URL, {
				max: 1,
				connection: { search_path: schema, statement_timeout: 15000 },
				onnotice: () => {}
			});
			connections.push(connection);
			const [{ pid }] = await connection`SELECT pg_backend_pid() AS pid`;
			return { connection, pid };
		}
		async function waitForLocks(runs) {
			const names = runs.map((run) => run.name),
				deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const rows =
					await sql`SELECT pid FROM pg_stat_activity WHERE application_name=ANY(${names}::text[])
					AND state='active' AND wait_event_type='Lock'`;
				if (rows.length === runs.length) return rows.map((row) => row.pid);
				await delay(20);
			}
			assert.fail('Real CLI backends did not reach the expected PostgreSQL lock wait');
		}
		async function withWriter(write, verify) {
			const writer = await connect(),
				ready = Promise.withResolvers(),
				release = Promise.withResolvers();
			const writing = writer.connection.begin(async (tx) => {
				await write(tx);
				ready.resolve();
				await release.promise;
			});
			writing.catch(ready.reject);
			let seeding;
			try {
				await ready.promise;
				seeding = launch();
				const [pid] = await waitForLocks([seeding]);
				assert.notEqual(pid, writer.pid);
			} finally {
				release.resolve();
				await writing;
			}
			const result = await seeding.done;
			await verify(result);
		}
		try {
			await t.test(
				'fresh install creates five documents, first revisions and six aliases exactly once',
				async () => {
					await reset();
					succeeded(await run(), 5, 0);
					const before = await snapshot();
					assert.equal(before.documents.length, 5);
					assert.equal(before.revisions.length, 5);
					assert.equal(before.redirects.length, 6);
					for (const doc of before.documents) {
						const revs = before.revisions.filter((r) => r.document_id === doc.id);
						assert.equal(revs.length, 1);
						assert.equal(revs[0].content, doc.content);
						assert.equal(revs[0].summary, '예시 문서 생성');
						assert.match(doc.title, /^예시:/);
						assert.match(doc.content, /예시/);
					}
					succeeded(await run(), 0, 5);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'reruns preserve user edits, removed aliases, microsecond timestamps and every related row',
				async () => {
					await reset();
					succeeded(await run(), 5, 0);
					const [doc] =
						await sql`UPDATE documents SET title='사용자가 정한 제목',content='사용자가 검토한 새 본문',editor_handle='Editor-42',updated_at='2026-09-20 12:34:56.123456+00'
					WHERE slug='예시:장비-인계-절차' RETURNING id`;
					await sql`DELETE FROM redirects WHERE document_id=${doc.id}`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('legacy-user-address','사용자 별칭',${doc.id})`;
					await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${doc.id},'사용자가 검토한 새 본문','Editor-42','[AI 통합 · 새 초안 우선] 유지할 이력')`;
					await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${doc.id},'기존 의견','유지할 토론','Editor-42')`;
					await sql`INSERT INTO drafts(title,slug,content,status,governance) VALUES('기존 게시 초안','previous-draft','초안 본문','published','{"published":{"slug":"예시:장비-인계-절차"},"merge":{"preserved":true}}')`;
					await sql`INSERT INTO announcements(title,body) VALUES('기존 공지','보존할 공지')`;
					const before = await snapshot();
					succeeded(await run(), 0, 5);
					succeeded(await run(), 0, 5);
					assert.deepEqual(await snapshot(), before);
				}
			);
			for (const archived of [false, true])
				for (const collision of [
					'title',
					'canonical',
					'canonical-as-alias',
					'alias-as-canonical',
					'alias',
					'alias-as-title',
					'title-as-alias-label',
					'alias-label'
				]) {
					await t.test(
						`${archived ? 'archived' : 'active'} ${collision} collision skips the complete item without changing owners`,
						async () => {
							await reset();
							const title = '예시:정비 요청 절차',
								slug = slugify(title),
								aliasTitle = '예시:정비 요청서',
								alias = slugify(aliasTitle);
							const [owner] =
								await sql`INSERT INTO documents(title,slug,content) VALUES(${collision === 'title' ? title : collision === 'alias-as-title' ? aliasTitle : '기존 사용자 문서'},${collision === 'canonical' ? slug : collision === 'alias-as-canonical' ? alias : 'existing-owner'},'보존할 기존 본문') RETURNING id`;
							if (collision === 'canonical-as-alias' || collision === 'alias')
								await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${collision === 'alias' ? alias : slug},'보존할 주소',${owner.id})`;
							if (collision === 'title-as-alias-label' || collision === 'alias-label')
								await sql`INSERT INTO redirects(alias_slug,alias_title,document_id)
									VALUES ('legacy-alias',${collision === 'title-as-alias-label' ? title : aliasTitle},${owner.id})`;
							if (archived)
								await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-42',lifecycle_version=7 WHERE id=${owner.id}`;
							const before = await snapshot();
							succeeded(await run(), 4, 1, archived ? 1 : 0);
							const after = await snapshot();
							preserved(before, after);
							assert.equal(after.documents.length, 5);
							assert.equal(after.revisions.length, 4);
							assert.equal(
								after.redirects?.filter((r) => r.alias_slug === slugify('예시:수리 요청')).length ||
									0,
								0
							);
							succeeded(await run(), 0, 5, archived ? 1 : 0);
							assert.deepEqual(await snapshot(), after);
						}
					);
				}
			for (const table of ['documents', 'revisions', 'redirects'])
				for (const mode of ['raise', 'skip', 'remove-after']) {
					await t.test(
						`${table} ${mode} rolls back the whole batch and retry is safe`,
						async () => {
							await reset();
							await sql`INSERT INTO documents(slug,title,content) VALUES('untouched','기존 보존 문서','test-private-existing-content')`;
							const before = await snapshot();
							const condition =
								table === 'documents'
									? "NEW.title='예시:정비 요청 절차'"
									: table === 'redirects'
										? "NEW.alias_title='예시:정비 요청서'"
										: "EXISTS(SELECT 1 FROM documents WHERE id=NEW.document_id AND title='예시:정비 요청 절차')";
							await sql.unsafe(`CREATE FUNCTION fail_demo_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
					IF ${condition} THEN ${mode === 'raise' ? "RAISE EXCEPTION 'test-private-database-detail';" : mode === 'skip' ? 'RETURN NULL;' : `DELETE FROM ${table} WHERE id=NEW.id;`} END IF; RETURN NEW; END $$`);
							await sql.unsafe(
								`CREATE TRIGGER fail_demo_seed ${mode === 'remove-after' ? 'AFTER' : 'BEFORE'} INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_demo_seed()`
							);
							try {
								failed(await run());
								assert.deepEqual(await snapshot(), before);
							} finally {
								await sql.unsafe(`DROP TRIGGER fail_demo_seed ON ${table}`);
								await sql`DROP FUNCTION fail_demo_seed()`;
							}
							succeeded(await run(), 5, 0);
							const after = await snapshot();
							preserved(before, after);
							assert.equal(after.documents.length, 6);
							assert.equal(after.revisions.length, 5);
							assert.equal(after.redirects.length, 6);
							succeeded(await run(), 0, 5);
							assert.deepEqual(await snapshot(), after);
						}
					);
				}
			await t.test(
				'two simultaneous Bun CLIs wait on independent backends and create one batch',
				async () => {
					await reset();
					const gate = await connect(),
						ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const holding = gate.connection.begin(async (tx) => {
						await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
						ready.resolve();
						await release.promise;
					});
					holding.catch(ready.reject);
					let runs;
					try {
						await ready.promise;
						runs = [launch(), launch()];
						const pids = await waitForLocks(runs);
						assert.equal(new Set([gate.pid, ...pids]).size, 3);
					} finally {
						release.resolve();
						await holding;
					}
					const results = await Promise.all(runs.map((r) => r.done));
					const creator = results.find((r) => /생성 5개/.test(r.stdout)),
						skipper = results.find((r) => /생성 0개/.test(r.stdout));
					succeeded(creator, 5, 0);
					succeeded(skipper, 0, 5);
					const after = await snapshot();
					assert.equal(after.documents.length, 5);
					assert.equal(after.revisions.length, 5);
					assert.equal(after.redirects.length, 6);
				}
			);
			await t.test(
				'a pending user edit commits before the CLI rechecks existing data',
				async () => {
					await reset();
					succeeded(await run(), 5, 0);
					await withWriter(
						async (tx) => {
							const [doc] =
								await tx`UPDATE documents SET content='동시에 작성한 사용자 본문',editor_handle='Editor-77',updated_at='2026-09-21 01:02:03.654321+00' WHERE slug='예시:장비-인계-절차' RETURNING id`;
							await tx`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${doc.id},'동시에 작성한 사용자 본문','Editor-77','동시 편집')`;
						},
						async (result) => {
							succeeded(result, 0, 5);
							const after = await snapshot();
							const doc = after.documents.find((d) => d.slug === '예시:장비-인계-절차');
							assert.equal(doc.content, '동시에 작성한 사용자 본문');
							assert.equal(doc.editor_handle, 'Editor-77');
							assert.match(doc.updated_at, /654321/);
							assert.equal(after.revisions.length, 6);
						}
					);
				}
			);
			for (const claim of ['route', 'title-label', 'alias-label'])
				await t.test(`a pending alias ${claim} wins over the new demo`, async () => {
					await reset();
					const [owner] =
						await sql`INSERT INTO documents(slug,title,content) VALUES('owner','별칭 소유 문서','보존 본문') RETURNING id`;
					await withWriter(
						(tx) =>
							tx`INSERT INTO redirects(alias_slug,alias_title,document_id)
							VALUES (${claim === 'route' ? '예시:장비-인계-절차' : 'legacy-alias'},${claim === 'title-label' ? '예시:장비 인계 절차' : claim === 'alias-label' ? '예시:장비 인수인계' : '기존 주소'},${owner.id})`,
						async (result) => {
							succeeded(result, 4, 1);
							assert.equal(
								(await sql`SELECT id FROM documents WHERE slug='예시:장비-인계-절차'`).length,
								0
							);
							const [alias] = await sql`SELECT * FROM redirects WHERE document_id=${owner.id}`;
							assert.equal(String(alias.document_id), String(owner.id));
						}
					);
				});
			await t.test(
				'lock timeout reports failure without data changes and allows retry',
				async () => {
					await reset();
					const before = await snapshot(),
						gate = await connect(),
						ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const holding = gate.connection.begin(async (tx) => {
						await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
						ready.resolve();
						await release.promise;
					});
					holding.catch(ready.reject);
					try {
						await ready.promise;
						const cli = launch();
						await waitForLocks([cli]);
						failed(await cli.done);
						assert.deepEqual(await snapshot(), before);
					} finally {
						release.resolve();
						await holding;
					}
					succeeded(await run(), 5, 0);
				}
			);
			await t.test(
				'backend termination during the batch rolls back earlier documents and exits safely',
				async () => {
					await reset();
					const before = await snapshot(),
						gate = await connect();
					await gate.connection`SELECT pg_advisory_lock(hashtext(${schema + ':demo'}))`;
					await sql.unsafe(
						`CREATE FUNCTION pause_demo_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='예시:정비 요청 절차' THEN PERFORM pg_advisory_xact_lock(hashtext('${schema}:demo')); END IF; RETURN NEW; END $$`
					);
					await sql`CREATE TRIGGER pause_demo_seed BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION pause_demo_seed()`;
					try {
						const cli = launch();
						const [pid] = await waitForLocks([cli]);
						assert.notEqual(pid, gate.pid);
						await sql`SELECT pg_terminate_backend(${pid})`;
						failed(await cli.done);
						assert.deepEqual(await snapshot(), before);
					} finally {
						await gate.connection`SELECT pg_advisory_unlock_all()`;
						await sql`DROP TRIGGER pause_demo_seed ON documents`;
						await sql`DROP FUNCTION pause_demo_seed()`;
					}
					succeeded(await run(), 5, 0);
				}
			);
			await t.test(
				'missing or malformed configuration fails without leaking connection details',
				async () => {
					await reset();
					const before = await snapshot();
					const missing = await run({ databaseUrl: '' });
					assert.equal(missing.code, 1);
					assert.equal(missing.stdout, '');
					assert.match(missing.stderr, /DATABASE_URL이 필요합니다/);
					const malformed = await run({ databaseUrl: 'test-private-not-a-database-url' });
					failed(malformed);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'Node CLI uses the same preservation flow without relying on Bun globals',
				async () => {
					await reset();
					succeeded(await run({ runtime: process.execPath }), 5, 0);
					const before = await snapshot();
					succeeded(await run({ runtime: process.execPath }), 0, 5);
					assert.deepEqual(await snapshot(), before);
				}
			);
		} finally {
			for (const child of children)
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			await Promise.all(connections.map((connection) => connection.end({ timeout: 1 })));
			await state.closeDatabase();
			await rm(dir, { recursive: true, force: true });
		}
	}
);
