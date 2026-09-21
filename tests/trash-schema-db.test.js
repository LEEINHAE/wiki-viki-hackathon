import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repairTrashSchema, TrashSchemaError } from '../scripts/lib/trash-schema.js';
import * as state from './fixtures/governance-database.js';

test(
	'targeted trash schema repair with isolated PostgreSQL',
	{
		skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1',
		timeout: 30000
	},
	async (t) => {
		await state.setupDatabase({ maxConnections: 4 });
		const sql = state.db();
		const [{ schema }] = await sql`SELECT current_schema() AS schema`;
		const directory = await mkdtemp(join(tmpdir(), 'wiki-trash-schema-'));
		const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
		target.searchParams.set('options', '-c search_path=' + schema);
		const script = fileURLToPath(new URL('../scripts/repair-trash-schema.js', import.meta.url));
		await writeFile(join(directory, '.env'), '');
		await writeFile(
			join(directory, 'deny-network.mjs'),
			'globalThis.fetch = () => { throw new Error("External HTTP disabled"); };'
		);
		const cli = (args = [], runtime = 'bun', url = target.toString()) =>
			promisify(execFile)(
				runtime,
				runtime === 'bun'
					? ['--env-file=./.env', '--preload=./deny-network.mjs', script, ...args]
					: ['--import=./deny-network.mjs', script, ...args],
				{ cwd: directory, env: { PATH: process.env.PATH, DATABASE_URL: url }, timeout: 10000 }
			);
		const missing = async () => {
			await sql`ALTER TABLE documents DROP COLUMN IF EXISTS lifecycle_version`;
		};
		try {
			await t.test('healthy schemas and CLI checks do not change counters', async () => {
				await sql`INSERT INTO documents(title,slug,content,lifecycle_version) VALUES ('기존 문서','existing','원문',12)`;
				assert.deepEqual(await repairTrashSchema({ sql }), { status: 'ready' });
				assert.deepEqual(await repairTrashSchema({ sql, apply: true }), { status: 'ready' });
				assert.match((await cli(['--check'])).stdout, /정상/);
				assert.equal(
					(await sql`SELECT lifecycle_version FROM documents`)[0].lifecycle_version,
					'12'
				);
			});
			await t.test(
				'check-only CLI reports missing state; apply is repeatable and enforces nonnegative counters',
				async () => {
					await missing();
					await assert.rejects(cli(), (e) => e.code === 2 && /누락/.test(e.stdout));
					assert.deepEqual(await repairTrashSchema({ sql }), {
						status: 'missing-lifecycle-version'
					});
					assert.match((await cli(['--apply'])).stdout, /보정 완료/);
					assert.match((await cli(['--apply'], 'node')).stdout, /변경하지 않았습니다/);
					assert.equal(
						(await sql`SELECT lifecycle_version FROM documents`)[0].lifecycle_version,
						'0'
					);
					await assert.rejects(
						sql`UPDATE documents SET lifecycle_version=-1`,
						(e) => e.code === '23514'
					);
					await assert.rejects(
						sql`UPDATE documents SET lifecycle_version=NULL`,
						(e) => e.code === '23502'
					);
				}
			);
			await t.test(
				'failure before commit rolls back the actual ALTER TABLE and permits retry',
				async () => {
					await missing();
					await assert.rejects(
						repairTrashSchema({
							apply: true,
							sql: {
								begin: (options, fn) =>
									sql.begin(options, async (tx) => {
										await fn(tx);
										assert.equal(
											(await tx`SELECT lifecycle_version FROM documents`)[0].lifecycle_version,
											'0'
										);
										throw new Error('interrupted before commit');
									})
							}
						}),
						/interrupted before commit/
					);
					assert.deepEqual(await repairTrashSchema({ sql }), {
						status: 'missing-lifecycle-version'
					});
					assert.deepEqual(await repairTrashSchema({ sql, apply: true }), { status: 'repaired' });
				}
			);
			await t.test('concurrent repairs serialize and add the column once', async () => {
				await missing();
				const results = await Promise.all([
					repairTrashSchema({ sql, apply: true }),
					repairTrashSchema({ sql, apply: true })
				]);
				assert.deepEqual(results.map((r) => r.status).sort(), ['ready', 'repaired']);
			});
			await t.test(
				'a real table lock times out without changes, then succeeds after release',
				async () => {
					await missing();
					const locked = Promise.withResolvers(),
						release = Promise.withResolvers();
					const holder = sql.begin(async (tx) => {
						await tx`LOCK TABLE documents IN ACCESS SHARE MODE`;
						locked.resolve();
						await release.promise;
					});
					try {
						await locked.promise;
						await assert.rejects(
							repairTrashSchema({ sql, apply: true, lockTimeoutMs: 50 }),
							(e) => e.code === '55P03'
						);
						assert.deepEqual(await repairTrashSchema({ sql }), {
							status: 'missing-lifecycle-version'
						});
					} finally {
						release.resolve();
						await holder;
					}
					assert.deepEqual(await repairTrashSchema({ sql, apply: true }), { status: 'repaired' });
				}
			);
			await t.test('unexpected column types fail without rewriting existing values', async () => {
				await missing();
				await sql`ALTER TABLE documents ADD COLUMN lifecycle_version TEXT NOT NULL DEFAULT 'legacy'`;
				await assert.rejects(repairTrashSchema({ sql, apply: true }), TrashSchemaError);
				await assert.rejects(
					cli(['--apply']),
					(e) => e.code === 1 && /기존 값을 변경하지/.test(e.stderr)
				);
				assert.equal(
					(await sql`SELECT lifecycle_version FROM documents`)[0].lifecycle_version,
					'legacy'
				);
				await missing();
				await sql`ALTER TABLE documents ALTER COLUMN deleted_by TYPE BIGINT USING NULL::bigint`;
				await assert.rejects(repairTrashSchema({ sql, apply: true }), TrashSchemaError);
			});
			await t.test(
				'CLI failure never prints connection credentials or raw driver errors',
				async () => {
					for (const args of [['--wrong'], ['--apply', '--check']])
						await assert.rejects(cli(args), (e) => e.code === 1 && /사용법/.test(e.stderr));
					await assert.rejects(
						cli(
							['--check'],
							'bun',
							'postgresql://private-user:private-password@127.0.0.1:1/wiki_viki_test_missing'
						),
						(e) => {
							assert.equal(e.code, 1);
							assert.doesNotMatch(
								e.stdout + e.stderr,
								/private-user|private-password|postgresql:|ECONNREFUSED/
							);
							return true;
						}
					);
				}
			);
		} finally {
			await state.closeDatabase();
			await rm(directory, { recursive: true, force: true });
		}
	}
);
