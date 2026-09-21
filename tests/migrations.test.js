import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readMigrations } from '../scripts/lib/migrations.js';

async function files(entries, verify) {
	const dir = await mkdtemp(join(tmpdir(), 'wiki-viki-migration-files-'));
	try {
		for (const [name, content] of entries) await writeFile(join(dir, name), content);
		await verify(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('migration discovery sorts numeric versions and hashes exact bytes', async () => {
	await files(
		[
			['010_later.sql', 'SELECT 10;'],
			['002_next.sql', 'SELECT 2;'],
			['001_initial.sql', 'SELECT 1;\n'],
			['README.md', 'Not a migration']
		],
		async (dir) => {
			const rows = await readMigrations(dir);
			assert.deepEqual(
				rows.map((row) => row.version),
				['1', '2', '10']
			);
			assert.equal(rows[0].checksum, createHash('sha256').update('SELECT 1;\n').digest('hex'));
			assert.equal(rows[0].source, 'SELECT 1;\n');
		}
	);
});
test('migration discovery refuses missing, empty, duplicate, malformed or linked SQL before DB work', async () => {
	for (const entries of [
		[],
		[['001_initial.sql', '-- only comment']],
		[['001_initial.sql', ';;;']],
		[
			['001_initial.sql', 'SELECT 1;'],
			['0001_duplicate.sql', 'SELECT 2;']
		],
		[['1_short.sql', 'SELECT 1;']],
		[['000_zero.sql', 'SELECT 1;']],
		[['9223372036854775808_large.sql', 'SELECT 1;']],
		[['001_bad.SQL', 'SELECT 1;']],
		[['001_encoding.sql', Buffer.from([0xff])]]
	])
		await files(entries, (dir) => assert.rejects(readMigrations(dir), { code: 'FILES' }));
	await files([['source.txt', 'SELECT 1;']], async (dir) => {
		await symlink(join(dir, 'source.txt'), join(dir, '001_link.sql'));
		await assert.rejects(readMigrations(dir), { code: 'FILES' });
	});
});
test('migration files cannot take over transaction boundaries', async () => {
	for (const sql of [
		'BEGIN; SELECT 1; COMMIT;',
		'SELECT 1;COMMIT;',
		'END;',
		'START /* outer /* inner */ end */ TRANSACTION;',
		"PREPARE TRANSACTION 'x';",
		'ROLLBACK;',
		'ABORT;',
		'SAVEPOINT x;',
		'RELEASE SAVEPOINT x;',
		'SET TRANSACTION READ ONLY;',
		'-- header\n CoMmIt AND CHAIN;',
		'-- carriage return\rCOMMIT;'
	])
		await files([['001_control.sql', sql]], (dir) =>
			assert.rejects(readMigrations(dir), { code: 'FILES' })
		);
});
test('transaction words inside strings, quoted names and function bodies stay valid', async () => {
	const source = String.raw`-- COMMIT;
 /* BEGIN; /* ROLLBACK; */ END; */
 SELECT 'COMMIT; doubled '' quote', E'escaped \' quote; END;', "COMMIT;";
 CREATE FUNCTION example() RETURNS void LANGUAGE plpgsql AS $body$
 BEGIN RAISE NOTICE 'COMMIT;'; END;
 $body$;`;
	await files([['001_quotes.sql', source]], async (dir) =>
		assert.equal((await readMigrations(dir))[0].source, source)
	);
	for (const source of ["SELECT 'unfinished", '/* unclosed', 'DO $body$ unclosed'])
		await files([['001_bad.sql', source]], (dir) =>
			assert.rejects(readMigrations(dir), { code: 'FILES' })
		);
});
