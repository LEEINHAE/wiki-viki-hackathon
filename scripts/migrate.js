import { openDatabase } from './database.js';
import { applyMigrations } from './migration-runner.js';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required.');
const sql = openDatabase();
try {
	const names = await sql.begin((tx) => applyMigrations(tx));
	for (const name of names) console.log(`Applied migrations/${name}`);
	if (!names.length) console.log('All migrations already applied.');
} finally {
	await sql.end();
}
