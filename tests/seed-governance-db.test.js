import test from 'node:test';
import assert from 'node:assert/strict';
import {
	mkdtemp,
	mkdir,
	copyFile,
	symlink,
	readdir,
	readFile,
	writeFile,
	rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { seedFiles } from '../scripts/lib/seed-files.js';
import { runSeed } from '../scripts/seed.js';
import * as state from './fixtures/governance-database.js';
import { generatedSeed, seedAIResponse, seedDocx, seedPdf } from './fixtures/seed-source.js';

test(
	'seed file governance with isolated PostgreSQL and real source files',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1' },
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), 'wiki-viki-seed-test-'));
		await state.setupDatabase();
		const sql = state.db();
		const directory = pathToFileURL(dir + '/');
		let logs;
		const logger = { log: (message) => logs.push(message), error: (message) => logs.push(message) };
		async function reset() {
			await state.clearDatabase();
			for (const file of await readdir(dir)) await rm(join(dir, file));
			logs = [];
		}
		const run = (apiKey = 'test-only-key') => seedFiles({ sql, directory, apiKey, logger });
		const docx = async (name, text = '장비 점검 기록') =>
			writeFile(join(dir, name), await seedDocx(text));
		function interceptAI(st, handler) {
			const calls = [];
			st.mock.method(globalThis, 'fetch', async (_url, options) => {
				const body = JSON.parse(options.body);
				calls.push(body);
				return handler
					? handler(body, calls.length)
					: seedAIResponse(body.text ? generatedSeed : { passed: true, reasons: [] });
			});
			return calls;
		}
		try {
			await t.test(
				'all shared sensitive-source rules and filenames block AI and draft writes',
				async (st) => {
					await reset();
					const calls = interceptAI(st);
					for (const [i, source] of [
						'900101-1000000 점검',
						'password=NotARealSecret42! 내역',
						'password=NotARealSecret42!',
						'900101-1000000',
						'api_key=NotARealSecret42!',
						'900101-1234567'
					].entries())
						await docx(`source-${i}.docx`, source);
					await writeFile(join(dir, '900101-1000000.docx'), 'invalid file that must not be parsed');
					const stats = await run();
					assert.deepEqual(stats, {
						total: 7,
						created: 0,
						blocked: 7,
						failed: 0,
						semanticSkipped: 0
					});
					assert.equal(calls.length, 0);
					assert.equal((await sql`SELECT * FROM drafts`).length, 0);
					assert.doesNotMatch(
						logs.join('\n'),
						/demo42|example.invalid|010-1234|900101|source-|invalid file/
					);
				}
			);
			await t.test(
				'keyless DOCX and PDF imports preserve original files and disclose skipped semantics',
				async (st) => {
					await reset();
					const calls = interceptAI(st);
					await docx('01-inspection#1.docx');
					await writeFile(join(dir, '02-inspection.pdf'), seedPdf('Equipment inspection record'));
					await docx('03-blocked.docx', 'password=NotARealSecret42!');
					const bytes = await readFile(join(dir, '01-inspection#1.docx'));
					const stats = await run('');
					assert.deepEqual(stats, {
						total: 3,
						created: 2,
						blocked: 1,
						failed: 0,
						semanticSkipped: 2
					});
					const rows = await sql`SELECT * FROM drafts ORDER BY source_name`;
					assert.equal(rows[0].title, '01-inspection#1');
					assert.match(rows[0].content, /장비 점검 기록/);
					assert.match(rows[1].content, /Equipment inspection record/);
					for (const row of rows) {
						assert.equal(row.status, 'review');
						assert.equal(row.governance.semantic.skipped, true);
						assert.equal(row.governance.regex.passed, true);
						assert.deepEqual(row.aliases, []);
					}
					assert.deepEqual(await readFile(join(dir, '01-inspection#1.docx')), bytes);
					assert.match(logs.join('\n'), /의미 검사는 생략/);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'semantic rejection, invalid result and provider failure stop generation and storage',
				async (st) => {
					for (const kind of ['rejected', 'invalid', 'outage']) {
						await st.test(kind, async (nested) => {
							await reset();
							await docx('private-source.docx');
							const calls = interceptAI(nested, () =>
								kind === 'outage'
									? Response.json(
											{ error: { message: 'test-private-provider-detail' } },
											{ status: 429 }
										)
									: seedAIResponse(
											kind === 'rejected'
												? { passed: false, reasons: ['test-private-model-detail'] }
												: { passed: 'true', reasons: [] }
										)
							);
							const stats = await run();
							assert.equal(stats.created, 0);
							assert.equal(stats[kind === 'rejected' ? 'blocked' : 'failed'], 1);
							assert.equal(calls.length, 1);
							assert.equal((await sql`SELECT * FROM drafts`).length, 0);
							assert.doesNotMatch(logs.join('\n'), /private-source|test-private/);
						});
					}
				}
			);
			await t.test(
				'safe imports inspect before generation and store valid governance and aliases',
				async (st) => {
					await reset();
					await docx('safe-source.docx');
					const calls = interceptAI(st);
					assert.equal((await run()).created, 1);
					assert.equal(calls.length, 2);
					assert.equal(calls[0].input, 'safe-source.docx\n장비 점검 기록');
					assert.equal(calls[0].store, false);
					assert.equal(calls[1].store, false);
					assert.deepEqual(JSON.parse(calls[1].input), {
						sourceName: 'safe-source.docx',
						sourceText: '장비 점검 기록'
					});
					const [row] = await sql`SELECT * FROM drafts`;
					assert.equal(row.title, generatedSeed.title);
					assert.deepEqual(row.aliases, generatedSeed.aliases);
					assert.equal(row.governance.semantic.skipped, false);
					assert.equal(row.governance.passed, true);
					assert.equal(row.status, 'review');
				}
			);
			await t.test(
				'unsafe generated aliases and malformed structures are never stored',
				async (st) => {
					for (const generated of [
						{ ...generatedSeed, aliases: ['900101-1000000'] },
						{ ...generatedSeed, sections: [] }
					]) {
						await st.test(
							Array.isArray(generated.aliases) ? JSON.stringify(generated.sections) : 'malformed',
							async (nested) => {
								await reset();
								await docx('safe.docx');
								interceptAI(nested, (body) =>
									seedAIResponse(body.text ? generated : { passed: true, reasons: [] })
								);
								const stats = await run();
								assert.equal(stats.created, 0);
								assert.equal(stats.blocked + stats.failed, 1);
								assert.equal((await sql`SELECT * FROM drafts`).length, 0);
							}
						);
					}
				}
			);
			await t.test(
				'corrupt and empty files do not prevent the next valid file from being saved',
				async (st) => {
					await reset();
					const calls = interceptAI(st);
					await writeFile(join(dir, '01-private.docx'), 'test-private-parser-detail');
					await docx('02-empty.docx', '');
					await docx('03-valid.docx');
					const stats = await run('');
					assert.deepEqual(stats, {
						total: 3,
						created: 1,
						blocked: 0,
						failed: 2,
						semanticSkipped: 1
					});
					assert.equal(calls.length, 0);
					assert.equal((await sql`SELECT * FROM drafts`)[0].source_name, '03-valid.docx');
					assert.doesNotMatch(logs.join('\n'), /01-private|test-private|zip|ENOENT/i);
				}
			);
			await t.test(
				'actual write failures preserve existing drafts and continue with the next source',
				async (st) => {
					await reset();
					interceptAI(st);
					const [existing] =
						await sql`INSERT INTO drafts (title,slug,content,aliases) VALUES ('기존 초안','기존-초안','사용자 작성 내용','["기존 별칭"]') RETURNING *`;
					await docx('01-rejected.docx');
					await docx('02-saved.docx');
					await sql.unsafe(
						"CREATE FUNCTION fail_seed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_name = '01-rejected.docx' THEN RAISE EXCEPTION 'test-private-database-detail'; END IF; RETURN NEW; END $$"
					);
					await sql.unsafe(
						'CREATE TRIGGER fail_seed BEFORE INSERT ON drafts FOR EACH ROW EXECUTE FUNCTION fail_seed()'
					);
					try {
						assert.deepEqual(await run(''), {
							total: 2,
							created: 1,
							blocked: 0,
							failed: 1,
							semanticSkipped: 1
						});
						assert.deepEqual(
							(await sql`SELECT * FROM drafts WHERE id=${existing.id}`)[0],
							existing
						);
						assert.equal((await sql`SELECT * FROM drafts`).length, 2);
						assert.doesNotMatch(logs.join('\n'), /test-private|01-rejected|02-saved/);
					} finally {
						await sql.unsafe('DROP TRIGGER fail_seed ON drafts');
					}
				}
			);
			await t.test(
				'the command entry point retains core setup and uses the guarded source pipeline',
				async (st) => {
					await reset();
					const calls = interceptAI(st);
					await docx('01-blocked.docx', 'password=NotARealSecret42!');
					await docx('02-safe.docx');
					const stats = await runSeed({ sql, directory, apiKey: '', logger });
					assert.equal(stats.blocked, 1);
					assert.equal(stats.created, 1);
					assert.equal((await sql`SELECT * FROM documents`).length, 5);
					assert.equal((await sql`SELECT * FROM revisions`).length, 5);
					assert.equal((await sql`SELECT * FROM drafts`).length, 1);
					assert.equal(calls.length, 0);
				}
			);
			await t.test(
				'the Bun command uses the guarded pipeline, safe logs and a failing exit status for partial errors',
				async () => {
					await reset();
					const cli = await mkdtemp(join(tmpdir(), 'wiki-viki-seed-cli-'));
					try {
						await mkdir(join(cli, 'scripts/lib'), { recursive: true });
						await mkdir(join(cli, 'seed-data'));
						for (const relative of ['scripts/seed.js', 'scripts/lib/seed-files.js'])
							await copyFile(new URL('../' + relative, import.meta.url), join(cli, relative));
						for (const relative of ['src', 'node_modules'])
							await symlink(
								fileURLToPath(new URL('../' + relative, import.meta.url)),
								join(cli, relative)
							);
						await writeFile(join(cli, 'package.json'), '{"type":"module"}');
						await writeFile(join(cli, '.env'), '');
						await writeFile(
							join(cli, 'deny-network.mjs'),
							"globalThis.fetch = () => { throw new Error('External HTTP prohibited in CLI verification'); };"
						);
						await writeFile(
							join(cli, 'seed-data/01-blocked.docx'),
							await seedDocx('password=NotARealSecret42!')
						);
						await writeFile(join(cli, 'seed-data/02-corrupt.docx'), 'test-private-parser-detail');
						await writeFile(join(cli, 'seed-data/03-safe.docx'), await seedDocx('점검 기록'));
						const [{ schema }] = await sql`SELECT current_schema() AS schema`;
						const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
						target.searchParams.set('options', '-c search_path=' + schema);
						await assert.rejects(
							promisify(execFile)(
								'bun',
								['run', '--preload=./deny-network.mjs', '--env-file=./.env', 'scripts/seed.js'],
								{
									cwd: cli,
									env: {
										PATH: process.env.PATH,
										DATABASE_URL: target.toString(),
										OPENAI_API_KEY: ''
									},
									timeout: 30000
								}
							),
							(failure) => {
								assert.equal(failure.code, 1);
								assert.match(failure.stdout, /초안 1개, 차단 1개, 실패 1개, 의미 검사 생략 1개/);
								assert.doesNotMatch(
									failure.stdout + failure.stderr,
									/demo42|test-private|01-blocked|02-corrupt|External HTTP/
								);
								return true;
							}
						);
						assert.equal((await sql`SELECT * FROM documents`).length, 5);
						const rows = await sql`SELECT * FROM drafts`;
						assert.equal(rows.length, 1);
						assert.equal(rows[0].source_name, '03-safe.docx');
						assert.equal(rows[0].governance.semantic.skipped, true);
					} finally {
						await rm(cli, { recursive: true, force: true });
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await rm(dir, { recursive: true, force: true });
		}
	}
);
