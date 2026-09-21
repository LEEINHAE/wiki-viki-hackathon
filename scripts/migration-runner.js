import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function applyMigrations(tx, directory = new URL('../migrations/', import.meta.url)) {
	const names = [];
	await tx`SELECT set_config('wv.operator','1',true)`;
	await tx`SELECT pg_advisory_xact_lock(21470921,1)`;
	await tx`CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
	for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
		const source = await readFile(new URL(name, directory), 'utf8');
		const checksum = createHash('sha256').update(source).digest('hex');
		const [applied] = await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
		if (applied) {
			if (applied.checksum !== checksum) throw Error(`Applied migration changed: ${name}`);
			continue;
		}
		await tx.unsafe(source);
		await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${checksum})`;
		names.push(name);
	}
	return names;
}
