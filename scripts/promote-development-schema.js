// Preserve an interactive fixture as persistent development data. This renames
// the existing namespace; it never copies, merges, drops or recreates its rows.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { databaseSchema } from '../src/lib/database-schema.js';

const option = (name) =>
	process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const from = option('from');
const to = option('to');
assert.ok(from && to, 'Provide --from=wiki_test_... and --to=wiki_development.');
databaseSchema({ WIKI_TEST_SCHEMA: from });
databaseSchema({ WIKI_DB_SCHEMA: to });
assert.notEqual(to, 'public', 'The public schema cannot be a promotion target.');
const execute = process.argv.includes('--execute');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

try {
	const result = await sql.begin(async (tx) => {
		await tx`SET LOCAL lock_timeout='5s'`;
		await tx`SELECT pg_advisory_xact_lock(21470921,1)`;
		const [source] = await tx`SELECT oid::text AS id FROM pg_namespace WHERE nspname=${from}`;
		assert.ok(source, 'Source schema does not exist.');
		assert.equal(
			(await tx`SELECT 1 FROM pg_namespace WHERE nspname=${to}`).length,
			0,
			'Target schema already exists.'
		);
		const tables =
			await tx`SELECT relname AS name FROM pg_class WHERE relnamespace=${source.id}::oid AND relkind='r' ORDER BY relname`;
		assert.ok(
			tables.some((table) => table.name === 'documents'),
			'Source is not a wiki schema.'
		);
		assert.equal(
			(
				await tx`SELECT 1 FROM pg_proc WHERE pronamespace=${source.id}::oid AND position(${from} IN prosrc)>0`
			).length,
			0,
			'A function hardcodes the old schema name.'
		);
		if (!execute) return { from, to, ready: true, executed: false, tables: tables.length };
		// Stop the serving process before execution. Locks also reject in-flight
		// writes rather than allowing a partial move; a timeout rolls everything back.
		await tx.unsafe(
			`LOCK TABLE ${tables.map(({ name }) => `${identifier(from)}.${identifier(name)}`).join(',')} IN ACCESS EXCLUSIVE MODE`
		);
		if (tables.some((table) => table.name === 'wv_upload_jobs')) {
			const [active] =
				await tx`SELECT count(*)::int AS n FROM ${tx(`${from}.wv_upload_jobs`)} WHERE state IN('received','extracting','inspecting','generating','saving')`;
			assert.equal(active.n, 0, 'Wait for active uploads before promoting the schema.');
		}
		const fingerprint = (schema) =>
			tx.unsafe(
				tables
					.map(
						({ name }) =>
							`SELECT '${name.replaceAll("'", "''")}' AS name,count(*)::int AS rows,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS fingerprint FROM ${identifier(schema)}.${identifier(name)} t`
					)
					.join(' UNION ALL ')
			);
		const before = await fingerprint(from);
		await tx`ALTER SCHEMA ${tx(from)} RENAME TO ${tx(to)}`;
		const [target] = await tx`SELECT oid::text AS id FROM pg_namespace WHERE nspname=${to}`;
		assert.equal(target.id, source.id, 'The namespace identity changed.');
		const after = await fingerprint(to);
		assert.deepEqual([...after], [...before], 'Stored data changed during promotion.');
		assert.equal((await tx`SELECT 1 FROM pg_namespace WHERE nspname=${from}`).length, 0);
		return {
			measuredAt: new Date().toISOString(),
			from,
			to,
			executed: true,
			namespaceIdentityPreserved: true,
			allRowsPreserved: true,
			tableCounts: Object.fromEntries(after.map((table) => [table.name, table.rows])),
			publicModified: false
		};
	});
	if (execute)
		await writeFile(
			new URL('../docs/development-schema-verification.json', import.meta.url),
			JSON.stringify(result, null, 2) + '\n'
		);
	console.log(JSON.stringify(result));
} finally {
	await sql.end();
}
