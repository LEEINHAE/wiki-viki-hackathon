import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../scripts/lib/migrations.js';

export const env = { OPENAI_API_KEY: 'test-only-key' };
let sql;
let schema;

export async function setupDatabase({ maxConnections = 1, prepare = true } = {}) {
	const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
	if (
		process.env.RUN_GOVERNANCE_DB_TESTS !== '1' ||
		!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
		!target.pathname.startsWith('/wiki_viki_test_')
	)
		throw new Error(
			'Governance tests require an explicitly enabled local wiki_viki_test_ database.'
		);
	schema = `governance_${randomUUID().replaceAll('-', '')}`;
	sql = postgres(target.toString(), {
		max: maxConnections,
		prepare,
		connection: { search_path: schema, application_name: schema },
		// Neon sends the application's pre-serialized JSON strings as-is.
		// Match that wire representation when running the same SQL via postgres.
		types: {
			json: {
				to: 114,
				from: [114, 3802],
				serialize: (value) => (typeof value === 'string' ? value : JSON.stringify(value)),
				parse: JSON.parse
			}
		},
		onnotice: () => {}
	});
	// Execute the same non-interactive transaction callback used by Neon against
	// a real PostgreSQL transaction, on one reserved backend per invocation.
	sql.transaction = (queries, options = {}) => {
		if (typeof queries !== 'function' || options.isolationLevel !== 'ReadCommitted')
			throw new Error('Unsupported test transaction shape.');
		return sql.begin('isolation level read committed', async (tx) => {
			const results = [];
			for (const query of queries(tx)) results.push(await query);
			return results;
		});
	};
	await sql.unsafe(`CREATE SCHEMA ${schema}`);
	await runMigrations({ sql });
}

export function db() {
	if (!sql) throw new Error('Isolated governance database is not initialized.');
	return sql;
}

export async function clearDatabase() {
	await sql`TRUNCATE documents, drafts RESTART IDENTITY CASCADE`;
}

export async function closeDatabase() {
	if (!sql) return;
	try {
		await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	} finally {
		await sql.end();
		sql = null;
	}
}
