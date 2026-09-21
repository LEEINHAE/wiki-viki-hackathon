// Run the same backup and upgrade used by the apply command, in disposable
// copies. Even a successful run rolls back the complete outer transaction.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { readLegacySnapshot, cloneLegacySchema, applyLegacyUpgrade } from './legacy-upgrade.js';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required.');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const schema = `wiki_test_legacy_${Date.now()}`;
const backup = `${schema}_backup`;
const rollback = new Error('rehearsal_complete_rollback');
let report;
try {
	try {
		await sql.begin('isolation level repeatable read', async (tx) => {
			const original = await readLegacySnapshot(tx, 'public');
			console.log('Preparing a disposable copy; public is read only.');
			await cloneLegacySchema(tx, original, schema);
			report = await applyLegacyUpgrade(tx, schema, backup);
			const again = await applyLegacyUpgrade(tx, schema, `${backup}_unused`);
			assert.equal(again.alreadyApplied, true);
			assert.deepEqual(again.newlyAppliedMigrations, []);
			// Neither a new migration nor a second backup appears on repeated application.
			assert.equal(
				(await tx`SELECT 1 FROM pg_namespace WHERE nspname=${`${backup}_unused`}`).length,
				0
			);
			const [saved] =
				await tx`SELECT wv_save_document_v1(${tx.json({ title: '호환 복사본 저장 검증', titleSlug: '호환-복사본-저장-검증', slug: '호환-복사본-저장-검증', content: '합성 검증 본문입니다.', editor: 'Operator-A', field: '일반', description: '합성 검증', sourceName: '합성 검증', aliases: [], tags: [], summary: '복사본 쓰기 검증' })}::jsonb) AS document`;
			assert.ok(
				Number(saved.document.id) >
					Number((await tx`SELECT max(id) AS id FROM public.documents`)[0].id)
			);
			assert.equal(
				(
					await tx`SELECT count(*)::int AS n FROM revisions WHERE document_id=${saved.document.id}`
				)[0].n,
				1
			);
			await assert.rejects(
				tx.savepoint(async (sp) => {
					await sp`SELECT set_config('wv.operator','0',true),set_config('wv.actor_role','',true),set_config('wv.actor_id','',true)`;
					await sp`UPDATE documents SET content=content WHERE id=${saved.document.id}`;
				}),
				/forbidden/
			);
			report.checks.push(
				'Repeated application performs no migration and creates no extra backup',
				'A synthetic new document creates exactly one revision',
				'An old writer without the new actor context is rejected'
			);
			report.environment = 'Remote Neon; same apply procedure inside a disposable legacy copy';
			report.limitations.push('No production migration, server switch or deployment performed');
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}
	assert.equal(
		(
			await sql`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN(${schema},${backup})`
		)[0].n,
		0
	);
	report.rolledBack = true;
	await writeFile(
		new URL('../docs/legacy-upgrade-rehearsal.json', import.meta.url),
		JSON.stringify(report, null, 2) + '\n'
	);
	console.log(JSON.stringify(report));
} finally {
	await sql.end();
}
