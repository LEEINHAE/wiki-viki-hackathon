import postgres from 'postgres';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
	const migration = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
	await sql.unsafe(migration);
	console.log('Applied migrations/001_initial.sql');
} finally { await sql.end(); }
