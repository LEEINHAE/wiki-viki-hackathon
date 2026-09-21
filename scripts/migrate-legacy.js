import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { databaseSchema } from '../src/lib/database-schema.js';
import { applyLegacyUpgrade, readLegacySnapshot } from './legacy-upgrade.js';

const source = process.argv.find((arg) => arg.startsWith('--schema='))?.slice(9);
assert.ok(source, 'Name the existing schema explicitly with --schema=public.');
databaseSchema({ WIKI_DB_SCHEMA: source });
const apply = process.argv.includes('--apply');
if (apply)
	assert.ok(
		process.argv.includes('--writers-stopped'),
		'Stop the old application writers before using --apply --writers-stopped.'
	);
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
	if (!apply) {
		const report = await sql.begin('read only', async (tx) => {
			const snapshot = await readLegacySnapshot(tx, source);
			return { source, sourceCounts: snapshot.counts, ready: true, applied: false };
		});
		console.log(JSON.stringify(report));
	} else {
		const backup = `wiki_backup_legacy_${Date.now()}_${randomBytes(4).toString('hex')}`;
		const report = await sql.begin((tx) => applyLegacyUpgrade(tx, source, backup));
		// The same report is committed in wv_legacy_upgrade, so an interrupted
		// terminal or local file write cannot hide whether the DB commit succeeded.
		await writeFile(
			new URL('../docs/legacy-upgrade-application.json', import.meta.url),
			JSON.stringify({ ...report, committed: true }, null, 2) + '\n'
		);
		console.log(JSON.stringify({ ...report, committed: true }));
	}
} finally {
	await sql.end();
}
