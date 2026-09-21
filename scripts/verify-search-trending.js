// Real PostgreSQL regression; all fixtures live in a checked disposable schema.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { applyMigrations } from './migration-runner.js';
import { seedDocument } from './seed-helpers.js';

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const schema = `wiki_test_trending_${Date.now()}`;
const checks = [];
try {
	await sql`CREATE SCHEMA ${sql(schema)}`;
	await sql.begin(async (tx) => {
		await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
		assert.equal((await tx`SELECT current_schema() AS name`)[0].name, schema);
		await applyMigrations(tx);
		const doc = await seedDocument(tx, {
			title: '검색 집계 합성 문서',
			content: '합성 검증 본문입니다.'
		});
		const hidden = await seedDocument(tx, {
			title: '제한 검색 합성 문서',
			content: '합성 검증 본문입니다.'
		});
		await tx`UPDATE documents SET wv_min_role='admin' WHERE id=${hidden.id}`;
		const [reader] =
			await tx`INSERT INTO wv_users(handle,password_hash,role) VALUES('Operator-51','unused-fixture','reader') RETURNING id`;
		const [admin] =
			await tx`INSERT INTO wv_users(handle,password_hash,role) VALUES('Operator-52','unused-fixture','admin') RETURNING id`;
		async function actor(user, role) {
			await tx`SELECT set_config('wv.operator','0',true),set_config('wv.actor_id',${String(user.id)},true),set_config('wv.actor_role',${role},true)`;
		}
		const record = async (query, visitor, documentId = doc.id) =>
			(
				await tx`SELECT wv_record_search_v1(${tx.json({ query, key: query.toLowerCase(), visitor: createHash('sha256').update(visitor).digest('hex'), documentId })}::jsonb) AS ok`
			)[0].ok;
		const ranking = () => tx`SELECT * FROM wv_search_trending_v1()`;
		await actor(reader, 'reader');
		assert.equal((await ranking()).length, 0);
		assert.equal(await record('RFCC', 'one'), true);
		assert.equal(await record('rfcc', 'one'), false);
		assert.equal(await record('RFCC', 'two'), true);
		assert.equal(await record('CDU', 'one'), true);
		let rows = await ranking();
		assert.equal(rows[0].query, 'RFCC');
		assert.equal(Number(rows[0].count), 2);
		checks.push(
			'Empty state, normalized query aggregation, repeat deduplication and count ranking'
		);
		assert.equal(await record('제한 검색', 'one', hidden.id), false);
		await actor(admin, 'admin');
		assert.equal(await record('제한 검색', 'admin', hidden.id), true);
		assert.ok((await ranking()).some((r) => r.query === '제한 검색'));
		await tx`UPDATE documents SET wv_min_role='reader' WHERE id=${hidden.id}`;
		await actor(reader, 'reader');
		assert.ok(!(await ranking()).some((r) => r.query === '제한 검색'));
		await actor(admin, 'admin');
		await tx`UPDATE documents SET wv_min_role='admin' WHERE id=${doc.id}`;
		await actor(reader, 'reader');
		assert.equal((await ranking()).length, 0);
		await actor(admin, 'admin');
		await tx`UPDATE documents SET wv_min_role='reader',wv_archived_at=NOW() WHERE id=${doc.id}`;
		assert.ok(!(await ranking()).some((r) => r.query === 'RFCC'));
		await tx`UPDATE documents SET wv_archived_at=NULL,deleted_at=NOW() WHERE id=${doc.id}`;
		assert.ok(!(await ranking()).some((r) => r.query === 'RFCC'));
		await tx`UPDATE documents SET deleted_at=NULL WHERE id=${doc.id}`;
		checks.push('Current and historical access, archived and deleted result exclusion');
		await tx`UPDATE wv_search_events SET created_at=NOW()-interval '61 minutes'`;
		assert.equal((await ranking()).length, 0);
		await actor(reader, 'reader');
		for (let n = 0; n < 20; n++) assert.equal(await record(`검증 검색 ${n}`, 'bounded'), true);
		assert.equal(await record('추가 검색', 'bounded'), false);
		assert.equal((await ranking()).length, 10);
		assert.equal(Number((await tx`SELECT count(*) AS n FROM wv_search_events`)[0].n), 20);
		checks.push(
			'One-hour expiry and pruning, top-ten limit, 20-event visitor limit per five-minute bucket'
		);
	});
	const report = {
		measuredAt: new Date().toISOString(),
		environment: 'Remote Neon, isolated schema, migrations 001–025',
		checks,
		passed: true
	};
	await writeFile(
		new URL('../docs/search-trending-verification.json', import.meta.url),
		JSON.stringify(report, null, 2) + '\n'
	);
	console.log(JSON.stringify(report));
} finally {
	await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
	await sql.end();
}
