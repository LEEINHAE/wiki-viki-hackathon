import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { slugify } from '../src/lib/knowledge.js';
import * as state from './fixtures/governance-database.js';

test(
	'prototype seed preserves existing data through the real CLI and PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1', timeout: 90000 },
	async (t) => {
		await state.setupDatabase();
		const sql = state.db();
		const [{ schema }] = await sql`SELECT current_schema() AS schema`;
		const dir = await mkdtemp(join(tmpdir(), 'wiki-viki-prototype-seed-'));
		const connections = [],
			children = [];
		let sequence = 0;
		await mkdir(join(dir, 'scripts'));
		await copyFile(
			new URL('../scripts/seed-prototype.js', import.meta.url),
			join(dir, 'scripts/seed-prototype.js')
		);
		await symlink(
			fileURLToPath(new URL('../node_modules', import.meta.url)),
			join(dir, 'node_modules')
		);
		await writeFile(join(dir, '.env'), '');
		await writeFile(join(dir, 'package.json'), '{"type":"module"}');
		await mkdir(join(dir, 'seed-data'));
		await copyFile(
			new URL('../seed-data/prototype-documents.json', import.meta.url),
			join(dir, 'seed-data/prototype-documents.json')
		);
		await symlink(fileURLToPath(new URL('../src', import.meta.url)), join(dir, 'src'));
		await writeFile(
			join(dir, 'deny-network.mjs'),
			"globalThis.fetch = () => { throw new Error('External HTTP prohibited'); };"
		);
		const fixture = JSON.parse(
			await readFile(join(dir, 'seed-data/prototype-documents.json'), 'utf8')
		);
		const item = fixture.documents[0],
			draftItem = fixture.documents.find((d) => d.isDraft);

		function launch({ runtime = 'bun', databaseUrl } = {}) {
			const name = `${schema}_prototype_${++sequence}`;
			const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
			target.searchParams.set('options', '-c search_path=' + schema);
			target.searchParams.set('application_name', name);
			const child = spawn(
				runtime,
				runtime === 'bun'
					? [
							'run',
							'--preload=./deny-network.mjs',
							'--env-file=./.env',
							'scripts/seed-prototype.js'
						]
					: ['--import=./deny-network.mjs', 'scripts/seed-prototype.js'],
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
		function succeeded(result, published = 6, drafts = 1, skipped = 0) {
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.signal, null);
			const rows = JSON.parse(result.stdout);
			assert.equal(rows.length, 7);
			for (const [status, count] of Object.entries({ published, draft: drafts, skipped }))
				assert.equal(rows.filter((r) => r.status === status).length, count, result.stdout);
			return rows;
		}
		function failed(result) {
			assert.equal(result.code, 1);
			assert.equal(result.signal, null);
			assert.equal(result.stdout, '');
			assert.match(result.stderr, /프로토타입.*(?:완료하지 못했습니다|중단되었습니다)/);
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
				'creates six examples and one review draft with unchanged source, aliases and first revisions',
				async () => {
					await reset();
					succeeded(await run());
					const before = await snapshot();
					assert.equal(before.documents.length, 6);
					assert.equal(before.revisions.length, 6);
					assert.equal(before.redirects.length, 9);
					assert.equal(before.drafts.length, 1);
					for (const expected of fixture.documents) {
						const row = (expected.isDraft ? before.drafts : before.documents).find(
							(d) => d.title === expected.title
						);
						assert.ok(row);
						assert.match(row.content, /프로토타입에서 가져온 예시/);
						assert.ok(row.content.includes(expected.summary));
						assert.ok(row.content.includes(fixture.source));
						for (const section of expected.sections)
							for (const para of section.paras) assert.ok(row.content.includes(para));
						if (expected.isDraft) {
							assert.equal(row.status, 'review');
							assert.deepEqual(row.aliases, expected.aliases);
							assert.equal(row.governance.semantic.skipped, true);
							assert.equal(row.governance.seed.referenceDraft, true);
						} else {
							assert.equal(
								before.revisions.filter(
									(r) => r.document_id === row.id && r.content === row.content
								).length,
								1
							);
							assert.deepEqual(
								before.redirects.filter((r) => r.document_id === row.id).map((r) => r.alias_title),
								expected.aliases
							);
						}
					}
					succeeded(await run(), 0, 0, 7);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'reruns preserve edited and archived examples, removed aliases, history and renamed legacy reference draft',
				async () => {
					await reset();
					succeeded(await run());
					const [doc] =
						await sql`UPDATE documents SET title='사용자가 정한 이름',content='검토한 새 본문',editor_handle='Editor-42',updated_at='2026-09-20 12:34:56.123456+00',deleted_at=NOW(),deleted_by='Editor-42',lifecycle_version=3 WHERE slug=${slugify(item.title)} RETURNING id`;
					await sql`DELETE FROM redirects WHERE document_id=${doc.id}`;
					await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('legacy-reference','기존 별칭',${doc.id})`;
					await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${doc.id},'검토한 새 본문','Editor-42','사용자 수정')`;
					await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES(${doc.id},'토론','보존할 의견','Editor-42')`;
					await sql`UPDATE drafts SET title='수정한 인계 문서',slug='renamed-handover',aliases='[]',content='작성 중인 초안',updated_at='2026-09-20 12:34:56.123456+00'`;
					const before = await snapshot();
					succeeded(await run(), 0, 0, 7);
					assert.deepEqual(await snapshot(), before);
					await sql`UPDATE drafts SET status='published',governance=governance || '{"published":{"slug":"renamed-handover"}}'::jsonb`;
					const published = await snapshot();
					succeeded(await run(), 0, 0, 7);
					assert.deepEqual(await snapshot(), published);
				}
			);
			for (const archived of [false, true])
				for (const collision of [
					'title',
					'canonical',
					'title-alias-label',
					'canonical-as-alias',
					'alias-title',
					'alias-as-canonical',
					'alias-label',
					'alias-route'
				]) {
					await t.test(
						`${archived ? 'archived' : 'active'} ${collision} owner causes the entire example to be skipped`,
						async () => {
							await reset();
							const alias = item.aliases[0],
								slug = slugify(item.title),
								aliasSlug = slugify(alias);
							const [owner] =
								await sql`INSERT INTO documents(title,slug,content) VALUES(${collision === 'title' ? item.title : collision === 'alias-title' ? alias : '기존 소유자'},${collision === 'canonical' ? slug : collision === 'alias-as-canonical' ? aliasSlug : 'original-owner'},'보존 본문') RETURNING id`;
							if (
								['title-alias-label', 'canonical-as-alias', 'alias-label', 'alias-route'].includes(
									collision
								)
							)
								await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${collision === 'canonical-as-alias' ? slug : collision === 'alias-route' ? aliasSlug : 'legacy-alias'},${collision === 'title-alias-label' ? item.title : collision === 'alias-label' ? alias : '기존 별칭'},${owner.id})`;
							if (archived)
								await sql`UPDATE documents SET deleted_at=NOW(),deleted_by='Editor-42',lifecycle_version=4 WHERE id=${owner.id}`;
							const before = await snapshot();
							const results = succeeded(await run(), 5, 1, 1);
							assert.equal(results.find((r) => r.title === item.title).status, 'skipped');
							const after = await snapshot();
							preserved(before, after);
							assert.equal(after.documents.length, 6);
							assert.equal(after.revisions.length, 5);
							assert.equal(
								after.redirects.some((r) => r.alias_title === item.aliases[1]),
								false
							);
							succeeded(await run(), 0, 0, 7);
							assert.deepEqual(await snapshot(), after);
						}
					);
				}
			for (const collision of ['title', 'slug', 'alias-title', 'alias-label'])
				await t.test(
					`existing draft ${collision} preserves the complete example and draft`,
					async () => {
						await reset();
						await sql`INSERT INTO drafts(title,slug,content,aliases) VALUES(${collision === 'title' ? item.title : collision === 'alias-title' ? item.aliases[0] : '작성 중인 문서'},${collision === 'slug' ? slugify(item.title) : 'pending-user-draft'},'기존 작성 내용',${JSON.stringify(collision === 'alias-label' ? [item.aliases[0]] : [])}::jsonb)`;
						const before = await snapshot();
						succeeded(await run(), 5, 1, 1);
						const after = await snapshot();
						preserved(before, after);
						succeeded(await run(), 0, 0, 7);
						assert.deepEqual(await snapshot(), after);
					}
				);
			for (const table of ['documents', 'revisions', 'redirects', 'drafts'])
				for (const mode of ['raise', 'skip', 'remove-after'])
					await t.test(
						`${table} ${mode} cancels all inserts and permits a clean retry`,
						async () => {
							await reset();
							await sql`INSERT INTO documents(slug,title,content) VALUES('keep','보존 문서','test-private-content')`;
							const before = await snapshot();
							const condition =
								table === 'documents'
									? "NEW.title='산단스팀'"
									: table === 'redirects'
										? "NEW.alias_title='산업단지 공급 스팀'"
										: table === 'drafts'
											? 'TRUE'
											: "EXISTS(SELECT 1 FROM documents WHERE id=NEW.document_id AND title='산단스팀')";
							await sql.unsafe(
								`CREATE FUNCTION fail_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${mode === 'raise' ? "RAISE EXCEPTION 'test-private-failure';" : mode === 'skip' ? 'RETURN NULL;' : `DELETE FROM ${table} WHERE id=NEW.id;`} END IF; RETURN NEW; END $$`
							);
							await sql.unsafe(
								`CREATE TRIGGER fail_seed ${mode === 'remove-after' ? 'AFTER' : 'BEFORE'} INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_seed()`
							);
							try {
								failed(await run());
								assert.deepEqual(await snapshot(), before);
							} finally {
								await sql.unsafe(`DROP TRIGGER fail_seed ON ${table}`);
								await sql`DROP FUNCTION fail_seed()`;
							}
							succeeded(await run());
							const after = await snapshot();
							preserved(before, after);
							assert.equal(after.documents.length, 7);
							assert.equal(after.revisions.length, 6);
							assert.equal(after.redirects.length, 9);
							assert.equal(after.drafts.length, 1);
							succeeded(await run(), 0, 0, 7);
							assert.deepEqual(await snapshot(), after);
						}
					);
			await t.test(
				'two Bun CLIs serialize on independent backends without duplicate drafts',
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
					succeeded(
						results.find((r) => JSON.parse(r.stdout).some((row) => row.status === 'published'))
					);
					succeeded(
						results.find((r) => JSON.parse(r.stdout).every((row) => row.status === 'skipped')),
						0,
						0,
						7
					);
					const after = await snapshot();
					assert.equal(after.documents.length, 6);
					assert.equal(after.drafts.length, 1);
					assert.equal(after.revisions.length, 6);
					assert.equal(after.redirects.length, 9);
				}
			);
			for (const claim of ['canonical-alias', 'alias-label', 'draft'])
				await t.test(
					`a pending ${claim} writer is visible before deciding whether to create an example`,
					async () => {
						await reset();
						const [owner] =
							await sql`INSERT INTO documents(slug,title,content) VALUES('owner','기존 소유자','보존 본문') RETURNING id`;
						await withWriter(
							async (tx) => {
								if (claim === 'draft')
									await tx`INSERT INTO drafts(title,slug,content) VALUES(${draftItem.title},${slugify(draftItem.title)},'동시에 작성한 초안')`;
								else
									await tx`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${claim === 'canonical-alias' ? slugify(item.title) : 'legacy-claim'},${claim === 'alias-label' ? item.aliases[0] : '기존 별칭'},${owner.id})`;
							},
							async (result) => {
								succeeded(result, claim === 'draft' ? 6 : 5, claim === 'draft' ? 0 : 1, 1);
								if (claim === 'draft') assert.equal((await sql`SELECT * FROM drafts`).length, 1);
								else
									assert.equal(
										(await sql`SELECT id FROM documents WHERE slug=${slugify(item.title)}`).length,
										0
									);
							}
						);
					}
				);
			await t.test(
				'a pending rename of the reference draft keeps its identity after the lock wait',
				async () => {
					await reset();
					succeeded(await run());
					const before = await snapshot();
					let renamed;
					await withWriter(
						async (tx) => {
							await tx`UPDATE drafts SET title='동시에 바꾼 제목',slug='concurrent-draft',content='동시 편집 본문',aliases='[]',updated_at='2026-09-22 00:00:00.654321+00'`;
							renamed = (await tx`SELECT to_jsonb(d) AS data FROM drafts d`)[0].data;
						},
						async (result) => {
							succeeded(result, 0, 0, 7);
							assert.deepEqual(await snapshot(), { ...before, drafts: [renamed] });
						}
					);
				}
			);
			await t.test(
				'lock timeout returns a safe failure and a retry creates one complete batch',
				async () => {
					await reset();
					const before = await snapshot(),
						gate = await connect();
					const ready = Promise.withResolvers(),
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
					succeeded(await run());
				}
			);
			await t.test(
				'backend termination cancels earlier inserts without disclosing driver details',
				async () => {
					await reset();
					const before = await snapshot(),
						gate = await connect();
					await gate.connection`SELECT pg_advisory_lock(hashtext(${schema + ':prototype-test'}))`;
					await sql.unsafe(
						`CREATE FUNCTION pause_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title='산단스팀' THEN PERFORM pg_advisory_xact_lock(hashtext('${schema}:prototype-test')); END IF; RETURN NEW; END $$`
					);
					await sql`CREATE TRIGGER pause_seed BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION pause_seed()`;
					try {
						const cli = launch();
						const [pid] = await waitForLocks([cli]);
						assert.notEqual(pid, gate.pid);
						await sql`SELECT pg_terminate_backend(${pid})`;
						failed(await cli.done);
						assert.deepEqual(await snapshot(), before);
					} finally {
						await gate.connection`SELECT pg_advisory_unlock(hashtext(${schema + ':prototype-test'}))`;
						await sql`DROP TRIGGER pause_seed ON documents`;
						await sql`DROP FUNCTION pause_seed()`;
					}
					succeeded(await run());
				}
			);
			await t.test(
				'missing and malformed connection settings fail without exposing their values',
				async () => {
					await reset();
					const before = await snapshot();
					for (const databaseUrl of ['', 'not-a-database-test-private'])
						failed(await run({ databaseUrl }));
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test('Node CLI creates the same rows and safely skips a rerun', async () => {
				await reset();
				succeeded(await run({ runtime: process.execPath }));
				const before = await snapshot();
				succeeded(await run({ runtime: process.execPath }), 0, 0, 7);
				assert.deepEqual(await snapshot(), before);
			});
		} finally {
			for (const child of children)
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			await Promise.all(connections.map((connection) => connection.end({ timeout: 1 })));
			await state.closeDatabase();
			await rm(dir, { recursive: true, force: true });
		}
	}
);
