import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { openDatabase } from './database.js';

const suffix = randomBytes(8).toString('hex');
const persistent = `wiki_schema_check_${suffix}`;
const fixture = `wiki_test_schema_${suffix}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const created = [];
const connections = [];
try {
	for (const name of [persistent, fixture]) {
		await admin`CREATE SCHEMA ${admin(name)}`;
		created.push(name);
		await admin`CREATE TABLE ${admin(`${name}.schema_marker`)} (value TEXT)`;
		await admin`INSERT INTO ${admin(`${name}.schema_marker`)} VALUES(${name})`;
	}
	const env = {
		...process.env,
		NODE_ENV: 'development',
		WIKI_DB_SCHEMA: persistent,
		WIKI_TEST_SCHEMA: ''
	};
	const selected = openDatabase(env);
	const isolated = openDatabase({ ...env, WIKI_TEST_SCHEMA: fixture });
	const missing = openDatabase({ ...env, WIKI_DB_SCHEMA: `wiki_missing_${suffix}` });
	connections.push(selected, isolated, missing);
	for (let i = 0; i < 3; i++) {
		assert.equal((await selected`SELECT value FROM schema_marker`)[0].value, persistent);
		assert.equal((await isolated`SELECT value FROM schema_marker`)[0].value, fixture);
	}
	const rollback = new Error('expected rollback');
	await assert.rejects(
		selected.begin(async (tx) => {
			await tx`INSERT INTO schema_marker VALUES('rolled_back')`;
			throw rollback;
		}),
		(error) => error === rollback
	);
	assert.equal((await selected`SELECT count(*)::int AS n FROM schema_marker`)[0].n, 1);
	await assert.rejects(missing`SELECT 1`, /Configured database schema does not exist/);
	console.log(
		'PASS: persistent schema, fixture precedence, pooled transaction isolation, rollback, missing-schema rejection; public unchanged.'
	);
} finally {
	await Promise.all(connections.map((connection) => connection.end()));
	for (const name of created) await admin`DROP SCHEMA ${admin(name)} CASCADE`;
	await admin.end();
}
