import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
	const directory = new URL('../migrations/', import.meta.url);
	for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
		await sql.unsafe(await readFile(new URL(name, directory), 'utf8'));
		console.log(`Applied migrations/${name}`);
	}
} finally {
	await sql.end();
}
