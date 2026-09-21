import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runSeed } from '../scripts/seed.js';
import { slugify } from '../src/lib/knowledge.js';
import * as state from './fixtures/governance-database.js';

test(
	'basic seed preservation with isolated PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1', timeout: 30000 },
	async (t) => {
		await state.setupDatabase();
		const sql = state.db();
		const dir = await mkdtemp(join(tmpdir(), 'wiki-viki-core-seed-'));
		const directory = pathToFileURL(dir + '/');
		const connections = [];
		const [{ schema }] = await sql`SELECT current_schema() AS schema`;
		async function runCLI() {
			const cli = join(dir, 'cli');
			await mkdir(join(cli, 'scripts/lib'), { recursive: true });
			await mkdir(join(cli, 'seed-data'), { recursive: true });
			for (const relative of ['scripts/seed.js', 'scripts/lib/seed-files.js'])
				await copyFile(new URL('../' + relative, import.meta.url), join(cli, relative));
			for (const relative of ['src', 'node_modules']) {
				await rm(join(cli, relative), { force: true });
				await symlink(
					fileURLToPath(new URL('../' + relative, import.meta.url)),
					join(cli, relative)
				);
			}
			await writeFile(join(cli, 'package.json'), '{"type":"module"}');
			await writeFile(join(cli, '.env'), '');
			await writeFile(
				join(cli, 'deny-network.mjs'),
				"globalThis.fetch = () => { throw new Error('External HTTP prohibited in CLI verification'); };"
			);
			const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
			target.searchParams.set('options', '-c search_path=' + schema);
			return promisify(execFile)(
				'bun',
				['run', '--preload=./deny-network.mjs', '--env-file=./.env', 'scripts/seed.js'],
				{
					cwd: cli,
					env: { PATH: process.env.PATH, DATABASE_URL: target.toString(), OPENAI_API_KEY: '' },
					timeout: 10000
				}
			);
		}
		const run = (connection = sql, logs = []) =>
			runSeed({
				sql: connection,
				directory,
				logger: { log: (message) => logs.push(message), error: (message) => logs.push(message) }
			});
		const reset = () => sql`TRUNCATE documents, drafts, announcements RESTART IDENTITY CASCADE`;
		async function snapshot() {
			const [row] = await sql`SELECT jsonb_build_object(
				'documents', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
				'revisions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
				'redirects', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
				'discussions', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
				'drafts', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),
				'announcements', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM announcements a)
			) AS data`;
			return row.data;
		}
		async function connect() {
			// setupDatabase already validated the explicit local test target. Each client
			// uses a distinct backend, with timeouts so a failed lock assertion can unwind.
			const connection = postgres(process.env.GOVERNANCE_TEST_DATABASE_URL, {
				max: 1,
				connection: { search_path: schema, statement_timeout: 10000, lock_timeout: 8000 },
				onnotice: () => {}
			});
			connections.push(connection);
			const [{ pid }] = await connection`SELECT pg_backend_pid() AS pid`;
			return { connection, pid };
		}
		async function waitForLocks(pids) {
			const deadline = Date.now() + 4000;
			while (Date.now() < deadline) {
				const rows = await sql`SELECT pid FROM pg_stat_activity
					WHERE pid IN ${sql(pids)} AND state='active' AND wait_event_type='Lock'`;
				if (rows.length === pids.length) return;
				await delay(20);
			}
			assert.fail('Independent PostgreSQL backends did not reach the expected lock wait.');
		}
		async function seedWithBlockedWriter(write, verify) {
			const writer = await connect();
			const seeder = await connect();
			assert.notEqual(writer.pid, seeder.pid);
			const ready = Promise.withResolvers();
			const release = Promise.withResolvers();
			const writing = writer.connection.begin(async (tx) => {
				await write(tx);
				ready.resolve();
				await release.promise;
			});
			writing.catch(ready.reject);
			let seeding;
			try {
				await ready.promise;
				seeding = run(seeder.connection);
				seeding.catch(() => {});
				await waitForLocks([seeder.pid]);
			} finally {
				release.resolve();
				await Promise.all([writing, seeding]);
			}
			await verify();
		}
		try {
			await t.test(
				'reruns preserve edited documents, history, relations, drafts and announcements',
				async () => {
					await reset();
					await run();
					const [doc] = await sql`UPDATE documents SET content='사용자가 검토한 정책',
					editor_handle='Editor-42', updated_at='2026-09-20T12:34:56.123456Z'
					WHERE title='Wiki Viki:기본 정책' RETURNING id`;
					await sql`INSERT INTO revisions (document_id,content,editor_handle,summary)
					VALUES (${doc.id},'사용자가 검토한 정책','Editor-42','정책 수정')`;
					await sql`INSERT INTO redirects (alias_slug,alias_title,document_id)
					VALUES ('existing-policy','기존 정책',${doc.id})`;
					await sql`INSERT INTO discussions (document_id,thread_title,body,editor_handle)
					VALUES (${doc.id},'검토 의견','유지할 토론','Editor-42')`;
					await sql`INSERT INTO drafts (title,slug,content,governance)
					VALUES ('정책 초안','policy-draft','작성 중인 본문','{"passed":true}'::jsonb)`;
					await sql`UPDATE announcements SET body='수정한 환영 공지'`;
					const before = await snapshot();
					await run();
					await run();
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'creates five initial revisions once and reports actual created/skipped counts',
				async () => {
					await reset();
					const first = [];
					await run(sql, first);
					const before = await snapshot();
					assert.equal(before.documents.length, 5);
					assert.equal(before.revisions.length, 5);
					assert.equal(before.announcements.length, 1);
					for (const doc of before.documents) {
						const revisions = before.revisions.filter((r) => r.document_id === doc.id);
						assert.equal(revisions.length, 1);
						assert.equal(revisions[0].content, doc.content);
						assert.equal(revisions[0].editor_handle, doc.editor_handle);
					}
					assert.match(first.join('\n'), /생성 5개.*건너뜀 0개/);
					const second = [];
					await run(sql, second);
					assert.deepEqual(await snapshot(), before);
					assert.match(second.join('\n'), /생성 0개.*건너뜀 5개/);
				}
			);
			await t.test(
				'existing titles, slugs and alias routes win without losing unrelated rows',
				async () => {
					await reset();
					await sql`INSERT INTO documents (slug,title,content) VALUES
					('moved-policy','Wiki Viki:기본 정책','변경한 주소'),
					(${slugify('Wiki Viki:편집 지침')},'사용자가 변경한 제목','기존 주소'),
					('discussion-target','기존 토론 문서','별칭의 대상')`;
					await sql`INSERT INTO redirects (alias_slug,alias_title,document_id)
					SELECT ${slugify('Wiki Viki:토론')},'Wiki Viki:토론',id FROM documents
					WHERE slug='discussion-target'`;
					const before = await snapshot();
					await run();
					const after = await snapshot();
					assert.deepEqual(after.documents.slice(0, 3), before.documents);
					assert.deepEqual(after.redirects, before.redirects);
					assert.equal(after.documents.length, 5);
					assert.equal(after.revisions.length, 2);
					assert.equal(
						after.documents.some((d) => d.slug === slugify('Wiki Viki:토론')),
						false
					);
					await run();
					assert.deepEqual(await snapshot(), after);
				}
			);
			for (const archived of [false, true]) {
				await t.test(
					`Bun CLI preserves ${archived ? 'archived' : 'active'} alias labels with legacy URLs`,
					async () => {
						await reset();
						const [owner] = await sql`INSERT INTO documents (slug,title,content)
							VALUES ('original-owner','기존 사용자 문서','보존 본문') RETURNING id`;
						await sql`INSERT INTO redirects (alias_slug,alias_title,document_id)
							VALUES ('legacy-policy','Wiki Viki:기본 정책',${owner.id})`;
						await sql`INSERT INTO revisions (document_id,content,editor_handle,summary)
							VALUES (${owner.id},'보존 본문','Editor-42','사용자 작성')`;
						if (archived)
							await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-42',lifecycle_version=3
								WHERE id=${owner.id}`;
						const before = await snapshot();
						const first = await runCLI();
						assert.match(first.stdout, /생성 4개.*건너뜀 1개/);
						const after = await snapshot();
						assert.equal(after.documents.length, 5);
						assert.equal(after.revisions.length, 5);
						assert.deepEqual(after.documents[0], before.documents[0]);
						assert.deepEqual(after.revisions[0], before.revisions[0]);
						assert.deepEqual(after.redirects, before.redirects);
						assert.equal(
							after.documents.some((d) => d.title === 'Wiki Viki:기본 정책'),
							false
						);
						assert.match((await runCLI()).stdout, /생성 0개.*건너뜀 5개/);
						assert.deepEqual(await snapshot(), after);
					}
				);
			}
			for (const failure of ['revision', 'announcement']) {
				await t.test(
					`${failure} failure rolls back the whole core batch and allows retry`,
					async () => {
						await reset();
						await sql`INSERT INTO documents (slug,title,content) VALUES ('existing','기존 문서','보존 본문')`;
						const before = await snapshot();
						const table = failure === 'revision' ? 'revisions' : 'announcements';
						await sql.unsafe(`CREATE FUNCTION fail_core_seed() RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN
							${failure === 'revision' ? "IF EXISTS (SELECT 1 FROM documents WHERE id=NEW.document_id AND title='Wiki Viki:편집 지침') THEN" : ''}
							RAISE EXCEPTION 'synthetic core seed failure';
							${failure === 'revision' ? 'END IF;' : ''}
							RETURN NEW;
						END $$`);
						await sql.unsafe(`CREATE TRIGGER reject_core_seed BEFORE INSERT ON ${table}
						FOR EACH ROW EXECUTE FUNCTION fail_core_seed()`);
						try {
							await assert.rejects(run(), /synthetic core seed failure/);
							assert.deepEqual(await snapshot(), before);
						} finally {
							await sql.unsafe(`DROP TRIGGER reject_core_seed ON ${table}`);
							await sql`DROP FUNCTION fail_core_seed()`;
						}
						await run();
						const after = await snapshot();
						assert.equal(after.documents.length, 6);
						assert.equal(after.revisions.length, 5);
						assert.equal(after.announcements.length, 1);
						assert.deepEqual(after.documents[0], before.documents[0]);
					}
				);
			}
			await t.test(
				'overlapping seeds on distinct backends create each document, revision and notice once',
				async () => {
					await reset();
					const gate = await connect();
					const a = await connect();
					const b = await connect();
					assert.equal(new Set([gate.pid, a.pid, b.pid]).size, 3);
					const ready = Promise.withResolvers();
					const release = Promise.withResolvers();
					const holding = gate.connection.begin(async (tx) => {
						await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
						ready.resolve();
						await release.promise;
					});
					holding.catch(ready.reject);
					const pending = [];
					try {
						await ready.promise;
						pending.push(run(a.connection), run(b.connection));
						for (const promise of pending) promise.catch(() => {});
						await waitForLocks([a.pid, b.pid]);
					} finally {
						release.resolve();
						await Promise.all([holding, ...pending]);
					}
					const after = await snapshot();
					assert.equal(after.documents.length, 5);
					assert.equal(after.revisions.length, 5);
					assert.equal(after.announcements.length, 1);
					await run();
					assert.deepEqual(await snapshot(), after);
				}
			);
			await t.test('a concurrent committed user edit is preserved after waiting', async () => {
				await reset();
				await run();
				await seedWithBlockedWriter(
					async (tx) => {
						const [doc] = await tx`UPDATE documents SET content='동시에 저장한 사용자 본문',
							updated_at='2026-09-21T00:00:00.654321Z',editor_handle='Editor-77'
							WHERE title='Wiki Viki:기본 정책' RETURNING id`;
						await tx`INSERT INTO revisions (document_id,content,editor_handle,summary)
							VALUES (${doc.id},'동시에 저장한 사용자 본문','Editor-77','동시 저장')`;
					},
					async () => {
						const after = await snapshot();
						const doc = after.documents.find((d) => d.title === 'Wiki Viki:기본 정책');
						assert.equal(doc.content, '동시에 저장한 사용자 본문');
						assert.equal(doc.editor_handle, 'Editor-77');
						assert.equal(after.revisions.length, 6);
					}
				);
			});
			for (const claim of ['route', 'label'])
				await t.test(
					`a concurrent alias ${claim} insertion commits before checking the seed`,
					async () => {
						await reset();
						const [doc] = await sql`INSERT INTO documents (slug,title,content)
					VALUES ('alias-target','기존 별칭 대상','보존 본문') RETURNING id`;
						await seedWithBlockedWriter(
							(tx) => tx`INSERT INTO redirects (alias_slug,alias_title,document_id)
						VALUES (${claim === 'route' ? slugify('Wiki Viki:도움말') : 'legacy-help'},'Wiki Viki:도움말',${doc.id})`,
							async () => {
								const after = await snapshot();
								assert.equal(after.documents.length, 5);
								assert.equal(after.revisions.length, 4);
								assert.equal(after.redirects.length, 1);
								assert.equal(
									after.documents.some((d) => d.slug === slugify('Wiki Viki:도움말')),
									false
								);
							}
						);
					}
				);
		} finally {
			await Promise.all(connections.map((connection) => connection.end()));
			await state.closeDatabase();
			await rm(dir, { recursive: true, force: true });
		}
	}
);
