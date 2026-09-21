import postgres from 'postgres';
import { databaseSchema } from '../src/lib/database-schema.js';

// CLI writes and the web server must use the same database and schema.
export function openDatabase(env = process.env) {
	if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
	const schema = databaseSchema(env);
	const connection = postgres(env.DATABASE_URL, { max: 1 });
	const begin = (action) =>
		connection.begin(async (tx) => {
			await tx`SELECT set_config('search_path',${schema},true)`;
			const [current] = await tx`SELECT current_schema() AS name`;
			if (current.name !== schema) throw new Error('Configured database schema does not exist.');
			return action(tx);
		});
	const sql = (strings, ...values) => begin((tx) => tx(strings, ...values));
	sql.begin = begin;
	sql.end = () => connection.end();
	return sql;
}
