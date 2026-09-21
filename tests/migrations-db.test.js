import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
	mkdtemp,
	readFile,
	writeFile,
	copyFile,
	mkdir,
	symlink,
	rm,
	rename
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runMigrations, readMigrations } from '../scripts/lib/migrations.js';
import * as state from './fixtures/governance-database.js';

test(
	'migration history and recovery with isolated PostgreSQL',
	{
		skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1',
		timeout: 60000
	},
	async (t) => {
		await state.setupDatabase({ maxConnections: 4 });
		const sql = state.db(),
			[{ schema }] = await sql`SELECT current_schema() AS schema`;
		const dir = await mkdtemp(join(tmpdir(), 'wiki-viki-migrate-db-')),
			connections = [];
		const initial = await readFile(
			new URL('../migrations/001_initial.sql', import.meta.url),
			'utf8'
		);
		async function reset({ legacy = true } = {}) {
			await sql.unsafe(`DROP SCHEMA ${schema} CASCADE; CREATE SCHEMA ${schema}`);
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir);
			await writeFile(join(dir, '001_initial.sql'), initial);
			if (legacy) {
				await sql.unsafe(initial);
				const [doc] =
					await sql`INSERT INTO documents(slug,title,content,editor_handle,updated_at) VALUES ('기존-문서','기존 문서','보존할 본문','Editor-42','2026-09-20 12:34:56.123456+00') RETURNING *`;
				await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES (${doc.id},'이전 본문','Editor-42','[AI 통합 · 새 초안 우선] 보존할 상세 기록')`;
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES ('legacy-route','예전 주소',${doc.id})`;
				await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES (${doc.id},'토론','보존할 의견','Editor-42')`;
				await sql`INSERT INTO drafts(title,slug,content,source_name,aliases,governance,status) VALUES ('기존 초안','기존-초안','작성 중 본문','자료.docx','["기존 별칭"]','{"merge":{"id":"existing-proposal","conflicts":[{"topic":"보존"}]}}','review')`;
				await sql`INSERT INTO announcements(title,body) VALUES ('기존 공지','보존할 공지')`;
			}
		}
		async function snapshot() {
			const [row] =
				await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'announcements',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM announcements a)) AS data`;
			return row.data;
		}
		const run = (connection = sql, directory = dir, options = {}) =>
			runMigrations({ sql: connection, directory, ...options });
		const add = (name, content) => writeFile(join(dir, name), content);
		const history = () =>
			sql`SELECT version::text,name,checksum,applied_at FROM schema_migrations m ORDER BY m.version`;
		const exists = async (name) =>
			Boolean((await sql`SELECT to_regclass(${schema + '.' + name}) AS value`)[0].value);
		async function connect() {
			const connection = postgres(process.env.GOVERNANCE_TEST_DATABASE_URL, {
				max: 1,
				connection: { search_path: schema, statement_timeout: 15000, application_name: schema },
				onnotice: () => {}
			});
			connections.push(connection);
			const [{ pid }] = await connection`SELECT pg_backend_pid() AS pid`;
			return { connection, pid };
		}
		async function waitFor(pids, kind = 'Lock') {
			const deadline = Date.now() + 4000;
			while (Date.now() < deadline) {
				const rows =
					await sql`SELECT pid FROM pg_stat_activity WHERE pid IN ${sql(pids)} AND state='active' AND (wait_event_type=${kind} OR wait_event=${kind})`;
				if (rows.length === pids.length) return;
				await delay(20);
			}
			assert.fail('Independent PostgreSQL backends did not reach the expected wait');
		}
		try {
			await t.test(
				'the shipped trash migration preserves legacy rows and initializes reversible lifecycle state',
				async () => {
					await reset();
					const before = await snapshot();
					const result = await runMigrations({ sql });
					assert.deepEqual(result.applied, ['001_initial.sql', '002_document_trash.sql']);
					const after = await snapshot();
					for (const doc of after.documents) {
						assert.equal(doc.deleted_at, null);
						assert.equal(doc.deleted_by, null);
						assert.equal(doc.lifecycle_version, 0);
						delete doc.deleted_at;
						delete doc.deleted_by;
						delete doc.lifecycle_version;
					}
					assert.deepEqual(after, before);
					assert.deepEqual((await runMigrations({ sql })).applied, []);
					await assert.rejects(sql`UPDATE documents SET deleted_at=NOW()`, { code: '23514' });
					await assert.rejects(sql`UPDATE documents SET lifecycle_version=-1`, { code: '23514' });
				}
			);

			await t.test(
				'fresh schema applies all numbered files, records exact hashes and reruns without writes',
				async () => {
					await reset({ legacy: false });
					await add('010_later.sql', "UPDATE order_probe SET steps=steps||',10'");
					await add(
						'002_next.sql',
						"CREATE TABLE order_probe(steps text); INSERT INTO order_probe VALUES ('2');"
					);
					assert.deepEqual(await run(), {
						applied: ['001_initial.sql', '002_next.sql', '010_later.sql'],
						skipped: 0
					});
					assert.equal((await sql`SELECT steps FROM order_probe`)[0].steps, '2,10');
					const rows = await history();
					assert.deepEqual(
						rows.map((r) => r.version),
						['1', '2', '10']
					);
					assert.deepEqual(
						rows.map((r) => r.checksum),
						(await readMigrations(dir)).map((r) => r.checksum)
					);
					assert.deepEqual(await run(), { applied: [], skipped: 3 });
					assert.deepEqual(await history(), rows);
					assert.equal((await sql`SELECT steps FROM order_probe`)[0].steps, '2,10');
				}
			);
			await t.test(
				'legacy schema adoption preserves every existing row, relationship, precise timestamp and merge metadata',
				async () => {
					await reset();
					const before = await snapshot();
					assert.deepEqual(await run(), { applied: ['001_initial.sql'], skipped: 0 });
					assert.deepEqual(await snapshot(), before);
					const rows = await history();
					await run();
					assert.deepEqual(await snapshot(), before);
					assert.deepEqual(await history(), rows);
				}
			);
			await t.test('additive backfill preserves existing identity and relationships', async () => {
				await reset();
				await run();
				const before = await snapshot();
				await add(
					'002_backfill.sql',
					"ALTER TABLE documents ADD COLUMN migration_note TEXT; UPDATE documents SET migration_note='기존 문서'; ALTER TABLE documents ALTER COLUMN migration_note SET NOT NULL;"
				);
				assert.deepEqual(await run(), { applied: ['002_backfill.sql'], skipped: 1 });
				const after = await snapshot();
				assert.equal(after.documents[0].migration_note, '기존 문서');
				delete after.documents[0].migration_note;
				assert.deepEqual(after, before);
			});
			for (const legacy of [true, false])
				await t.test(
					`first-run middle failure rolls back bootstrap and every pending migration (legacy=${legacy})`,
					async () => {
						await reset({ legacy });
						const before = legacy ? await snapshot() : null;
						await add(
							'002_partial.sql',
							"ALTER TABLE documents ADD COLUMN partial_marker TEXT; UPDATE documents SET content='취소할 본문';"
						);
						await add('003_failure.sql', 'SELECT 1/0;');
						await assert.rejects(run(), { code: 'DATABASE' });
						assert.equal(await exists('schema_migrations'), false);
						if (legacy) {
							assert.deepEqual(await snapshot(), before);
							assert.equal(
								(
									await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=${schema} AND column_name='partial_marker'`
								)[0].n,
								0
							);
						} else assert.equal(await exists('documents'), false);
						await add('003_failure.sql', "UPDATE documents SET partial_marker='완료';");
						assert.equal((await run()).applied.length, 3);
						assert.equal((await history()).length, 3);
						assert.deepEqual((await run()).applied, []);
					}
				);
			await t.test(
				'later failure retains committed history and rolls back new DDL, backfill and new history together',
				async () => {
					await reset();
					await run();
					const before = await snapshot(),
						recorded = await history();
					await add(
						'002_partial.sql',
						"ALTER TABLE documents ADD COLUMN marker TEXT; UPDATE documents SET content='취소할 본문';"
					);
					await add('003_failure.sql', 'SELECT 1/0;');
					await assert.rejects(run(), { code: 'DATABASE' });
					assert.deepEqual(await snapshot(), before);
					assert.deepEqual(await history(), recorded);
					assert.equal(
						(
							await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=${schema} AND column_name='marker'`
						)[0].n,
						0
					);
					await add('003_failure.sql', "UPDATE documents SET marker='확인';");
					assert.deepEqual((await run()).applied, ['002_partial.sql', '003_failure.sql']);
					assert.equal((await history()).length, 3);
				}
			);
			for (const mode of ['modified', 'renamed', 'missing', 'retroactive', 'unknown'])
				await t.test(`applied history ${mode} is rejected before pending SQL`, async () => {
					await reset();
					await add('003_existing.sql', 'SELECT 3;');
					await run();
					const before = await snapshot(),
						recorded = await history();
					await add('004_pending.sql', "UPDATE documents SET content='실행되면 안 됨';");
					if (mode === 'modified') await add('001_initial.sql', initial + '\n');
					if (mode === 'renamed')
						await rename(join(dir, '003_existing.sql'), join(dir, '003_renamed.sql'));
					if (mode === 'missing') await rm(join(dir, '003_existing.sql'));
					if (mode === 'retroactive') await add('002_retroactive.sql', 'SELECT 2;');
					if (mode === 'unknown')
						await sql`INSERT INTO schema_migrations(version,name,checksum) VALUES (999,'999_unknown.sql',${'0'.repeat(64)})`;
					const expected = mode === 'unknown' ? await history() : recorded;
					await assert.rejects(run(), { code: 'HISTORY' });
					assert.deepEqual(await snapshot(), before);
					assert.deepEqual(await history(), expected);
				});
			for (const mode of ['before_skip', 'after_remove'])
				await t.test(
					`a history trigger cannot leave an unrecorded migration (${mode})`,
					async () => {
						await reset();
						await run();
						await add('002_backfill.sql', "UPDATE documents SET content='취소할 본문';");
						const before = await snapshot(),
							recorded = await history();
						await sql.unsafe(
							mode === 'before_skip'
								? 'CREATE FUNCTION skip_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$'
								: 'CREATE FUNCTION skip_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM schema_migrations WHERE version=NEW.version; RETURN NEW; END $$'
						);
						await sql.unsafe(
							`CREATE TRIGGER skip_record ${mode === 'before_skip' ? 'BEFORE' : 'AFTER'} INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION skip_record()`
						);
						await assert.rejects(run(), { code: 'RECORD' });
						assert.deepEqual(await snapshot(), before);
						assert.deepEqual(await history(), recorded);
						await sql`DROP TRIGGER skip_record ON schema_migrations`;
						assert.equal((await run()).applied.length, 1);
					}
				);
			await t.test(
				'explicit transaction control is refused before any SQL can commit',
				async () => {
					await reset();
					const before = await snapshot();
					await add('002_escape.sql', "UPDATE documents SET content='취소할 본문'; COMMIT;");
					await assert.rejects(run(), { code: 'FILES' });
					assert.deepEqual(await snapshot(), before);
					assert.equal(await exists('schema_migrations'), false);
				}
			);
			await t.test(
				'simultaneous first runs on different backends execute each migration once',
				async () => {
					await reset({ legacy: false });
					await add(
						'002_once.sql',
						'CREATE TABLE once_probe(n int); INSERT INTO once_probe VALUES(1);'
					);
					const a = await connect(),
						b = await connect();
					assert.notEqual(a.pid, b.pid);
					const ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`SELECT pg_advisory_xact_lock(1465273673,hashtext(${schema}))`;
						ready.resolve();
						await release.promise;
					});
					gate.catch(ready.reject);
					const pending = [];
					try {
						await ready.promise;
						pending.push(run(a.connection), run(b.connection));
						for (const p of pending) p.catch(() => {});
						await waitFor([a.pid, b.pid]);
					} finally {
						release.resolve();
						await Promise.all([gate, ...pending]);
					}
					const results = await Promise.all(pending);
					assert.deepEqual(results.map((r) => r.applied.length).sort(), [0, 2]);
					assert.deepEqual(results.map((r) => r.skipped).sort(), [0, 2]);
					assert.equal((await sql`SELECT count(*)::int AS n FROM once_probe`)[0].n, 1);
					assert.equal((await history()).length, 2);
				}
			);
			await t.test(
				'different concurrent releases cannot overwrite the winning checksum or run conflicting SQL',
				async () => {
					await reset();
					await run();
					await add('002_release.sql', "UPDATE documents SET content='release A';");
					const other = await mkdtemp(join(tmpdir(), 'wiki-viki-migration-release-'));
					await writeFile(join(other, '001_initial.sql'), initial);
					await writeFile(
						join(other, '002_release.sql'),
						"UPDATE documents SET content='release B';"
					);
					const a = await connect(),
						b = await connect(),
						ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`SELECT pg_advisory_xact_lock(1465273673,hashtext(${schema}))`;
						ready.resolve();
						await release.promise;
					});
					gate.catch(ready.reject);
					const pending = [];
					try {
						await ready.promise;
						pending.push(run(a.connection), run(b.connection, other));
						for (const p of pending) p.catch(() => {});
						await waitFor([a.pid, b.pid]);
					} finally {
						release.resolve();
						await Promise.allSettled([gate, ...pending]);
					}
					try {
						const results = await Promise.allSettled(pending);
						assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
						assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'HISTORY');
						const winner = results[0].status === 'fulfilled' ? 'A' : 'B';
						assert.equal(
							(await sql`SELECT content FROM documents`)[0].content,
							'release ' + winner
						);
						assert.equal((await history()).length, 2);
					} finally {
						await rm(other, { recursive: true, force: true });
					}
				}
			);
			await t.test(
				'lock timeout changes nothing and retry succeeds after the other transaction ends',
				async () => {
					await reset();
					const before = await snapshot(),
						a = await connect(),
						ready = Promise.withResolvers(),
						release = Promise.withResolvers();
					const gate = sql.begin(async (tx) => {
						await tx`SELECT pg_advisory_xact_lock(1465273673,hashtext(${schema}))`;
						ready.resolve();
						await release.promise;
					});
					gate.catch(ready.reject);
					try {
						await ready.promise;
						await assert.rejects(
							run(a.connection, dir, { lockTimeoutMs: 80 }),
							(error) => error.code === 'DATABASE' && error.cause.code === '55P03'
						);
						assert.deepEqual(await snapshot(), before);
						assert.equal(await exists('schema_migrations'), false);
					} finally {
						release.resolve();
						await gate;
					}
					assert.deepEqual((await run(a.connection)).applied, ['001_initial.sql']);
				}
			);
			await t.test(
				'the real Bun CLI reports committed counts, exits on failure, hides private DB errors and retries',
				async () => {
					await reset();
					const before = await snapshot(),
						cli = await mkdtemp(join(tmpdir(), 'wiki-viki-migrate-cli-'));
					try {
						await mkdir(join(cli, 'scripts/lib'), { recursive: true });
						await mkdir(join(cli, 'migrations'));
						for (const file of [
							'scripts/migrate.js',
							'scripts/lib/migrations.js',
							'migrations/001_initial.sql'
						])
							await copyFile(new URL('../' + file, import.meta.url), join(cli, file));
						await symlink(
							fileURLToPath(new URL('../node_modules', import.meta.url)),
							join(cli, 'node_modules')
						);
						await writeFile(join(cli, 'package.json'), '{"type":"module"}');
						await writeFile(join(cli, '.env'), '');
						await writeFile(
							join(cli, 'deny-network.mjs'),
							"globalThis.fetch=()=>{throw new Error('External HTTP prohibited');};"
						);
						const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
						target.searchParams.set(
							'options',
							'-c search_path=' + schema + ' -c application_name=' + schema
						);
						target.searchParams.set('application_name', schema);
						const command = (url = target.toString(), runtime = 'bun') =>
							promisify(execFile)(
								runtime,
								runtime === 'bun'
									? [
											'run',
											'--preload=./deny-network.mjs',
											'--env-file=./.env',
											'scripts/migrate.js'
										]
									: ['--import=./deny-network.mjs', 'scripts/migrate.js'],
								{ cwd: cli, env: { PATH: process.env.PATH, DATABASE_URL: url }, timeout: 20000 }
							);
						await writeFile(
							join(cli, 'migrations/002_failure.sql'),
							"UPDATE documents SET content='test-private-body'; DO $$ BEGIN RAISE NOTICE 'test-private-notice'; RAISE EXCEPTION 'test-private-error'; END $$;"
						);
						await assert.rejects(command(), (e) => {
							assert.equal(e.code, 1);
							assert.doesNotMatch(
								e.stdout + e.stderr,
								/test-private|postgresql:|External HTTP|적용 완료/
							);
							assert.match(e.stderr, /002_failure.sql.*DB 코드 P0001/);
							return true;
						});
						assert.deepEqual(await snapshot(), before);
						assert.equal(await exists('schema_migrations'), false);
						await writeFile(join(cli, 'migrations/002_failure.sql'), 'SELECT 2;');
						const result = await command();
						assert.match(result.stdout, /적용 2개, 기존 적용 유지 0개/);
						assert.match(result.stdout, /적용 완료: 001_initial.sql/);
						assert.match((await command()).stdout, /적용 0개, 기존 적용 유지 2개/);
						assert.deepEqual(await snapshot(), before);
						for (const [mode, runtime] of [
							['backend', 'bun'],
							['process', 'bun'],
							['backend', 'node']
						]) {
							const recorded = await history();
							await writeFile(
								join(cli, 'migrations/003_interrupted.sql'),
								"ALTER TABLE documents ADD COLUMN interrupted_marker TEXT; UPDATE documents SET content='test-private-body'; SELECT pg_sleep(10);"
							);
							const pending = command(target.toString(), runtime);
							pending.catch(() => {});
							let pid;
							const deadline = Date.now() + 4000;
							while (Date.now() < deadline) {
								const rows =
									await sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=${schema} AND wait_event='PgSleep' AND query LIKE '%interrupted_marker%' AND query LIKE '%pg_sleep(10)%'`;
								if (rows.length === 1) {
									pid = rows[0].pid;
									break;
								}
								await delay(20);
							}
							assert.ok(pid, 'Actual Bun migration must reach its pending SQL');
							if (mode === 'backend') await sql`SELECT pg_terminate_backend(${pid})`;
							else pending.child.kill('SIGKILL');
							await assert.rejects(pending, (error) => {
								assert.ok(error.code === 1 || error.signal === 'SIGKILL');
								if (mode === 'backend') assert.match(error.stderr, /마이그레이션/);
								assert.doesNotMatch(
									error.stdout + error.stderr,
									/test-private|postgresql:|적용 완료|TypeError/
								);
								return true;
							});
							assert.deepEqual(await snapshot(), before);
							assert.deepEqual(await history(), recorded);
						}
						await writeFile(join(cli, 'migrations/003_interrupted.sql'), 'SELECT 3;');
						assert.match((await command()).stdout, /적용 1개, 기존 적용 유지 2개/);

						await assert.rejects(command(''), (e) => {
							assert.equal(e.code, 1);
							assert.match(e.stderr, /DATABASE_URL이 필요/);
							return true;
						});
						await assert.rejects(
							command(
								'postgresql://test-private-user:test-private-password@127.0.0.1:1/wiki_viki_test_missing'
							),
							(e) => {
								assert.equal(e.code, 1);
								assert.doesNotMatch(e.stdout + e.stderr, /test-private|postgresql:|ECONNREFUSED/);
								return true;
							}
						);
					} finally {
						await rm(cli, { recursive: true, force: true });
					}
				}
			);
		} finally {
			for (const connection of connections) await connection.end({ timeout: 1 });
			await state.closeDatabase();
			await rm(dir, { recursive: true, force: true });
		}
	}
);
