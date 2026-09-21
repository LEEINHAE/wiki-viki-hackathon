import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { applyMigrations } from '../scripts/migration-runner.js';
import { seedPrototype } from '../scripts/prototype-seed.js';
import { draftFingerprint } from '../src/lib/server/merge-contract.js';

test(
	'PostgreSQL: existing data, atomic writes, races, trash and draft publication',
	{
		skip: process.env.RUN_MERGE_DB_TESTS !== '1' || !process.env.DATABASE_URL
	},
	async () => {
		const schema = `wiki_test_${Date.now()}_${process.pid}`;
		const admin = postgres(process.env.DATABASE_URL, {
			max: 1,
			connect_timeout: 10,
			onnotice: () => {}
		});
		const pool = postgres(process.env.DATABASE_URL, {
			max: 4,
			connect_timeout: 10,
			onnotice: () => {}
		});
		const run = (query) =>
			pool.begin(async (tx) => {
				await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
				assert.equal(
					(await tx`SELECT current_schema() AS name`)[0].name,
					schema,
					'must be isolated before any mutation'
				);
				await tx`SELECT set_config('wv.operator','1',true)`;
				return query(tx);
			});
		const sql = (strings, ...values) => run((tx) => tx(strings, ...values));
		sql.unsafe = (text) => run((tx) => tx.unsafe(text));
		sql.json = (value) => pool.json(value);
		const payload = (title, extra = {}) => ({
			title,
			slug: title,
			content: '## 개요\n\n점검 주기는 7일입니다.',
			editor: 'Editor-01',
			field: '일반',
			description: '',
			sourceName: '',
			aliases: [],
			...extra
		});
		const save = async (p) => (await sql`SELECT wv_save_document_v1(${sql.json(p)}) AS d`)[0].d;
		try {
			await admin`CREATE SCHEMA ${admin(schema)}`;
			for (const name of ['001_initial.sql', '002_prototype_features.sql'])
				await sql.unsafe(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
			await sql`INSERT INTO documents (title,slug,content) VALUES ('legacy','legacy','보존할 기존 본문')`;
			await sql`INSERT INTO revisions (document_id,content,editor_handle) SELECT id,content,editor_handle FROM documents`;
			const applied = await run((tx) => applyMigrations(tx));
			assert.ok(applied.includes('008_upload_jobs.sql'));
			assert.deepEqual(await run((tx) => applyMigrations(tx)), [], 'second run is a no-op');
			const checksum = (
				await sql`SELECT checksum FROM schema_migrations WHERE name='001_initial.sql'`
			)[0].checksum;
			await sql`UPDATE schema_migrations SET checksum='test-only-mismatch' WHERE name='001_initial.sql'`;
			await assert.rejects(() => run((tx) => applyMigrations(tx)), /Applied migration changed/);
			await sql`UPDATE schema_migrations SET checksum=${checksum} WHERE name='001_initial.sql'`;

			assert.equal(
				(await sql`SELECT content FROM documents WHERE slug='legacy'`)[0].content,
				'보존할 기존 본문'
			);
			assert.equal((await sql`SELECT document_state FROM revisions`)[0].document_state, null);
			let first = await save(
				payload('one', { aliases: [{ title: '별칭', slug: 'alias-one' }], tags: ['확인', '시험'] })
			);
			assert.deepEqual(
				(
					await sql`SELECT tag FROM wv_document_tags WHERE document_id=${first.id} ORDER BY tag`
				).map((t) => t.tag),
				['시험', '확인']
			);
			await assert.rejects(() => save(payload('alias-one')), /name_conflict/);
			await assert.rejects(
				() => save(payload('two', { aliases: [{ title: '첫 문서', slug: 'one' }] })),
				/alias_conflict/
			);
			assert.equal((await sql`SELECT count(*)::int AS n FROM documents`)[0].n, 2);
			const races = await Promise.allSettled(
				[1, 2].map((n) =>
					save(payload('one', { id: first.id, version: first.version, content: `동시 변경 ${n}` }))
				)
			);
			assert.equal(races.filter((r) => r.status === 'fulfilled').length, 1);
			first = races.find((r) => r.status === 'fulfilled').value;
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM redirects WHERE document_id=${first.id}`)[0].n,
				0
			);
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM revisions WHERE document_id=${first.id}`)[0].n,
				2
			);
			await sql.unsafe(
				"CREATE FUNCTION fail_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected_failure'; END $$"
			);
			await sql.unsafe(
				'CREATE TRIGGER fail_revision BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION fail_revision()'
			);
			await assert.rejects(
				() =>
					save(
						payload('one', {
							id: first.id,
							version: first.version,
							content: '실패해야 할 변경',
							aliases: [{ title: 'bad', slug: 'bad' }]
						})
					),
				/injected_failure/
			);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${first.id}`)[0].content,
				first.content
			);
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM redirects WHERE alias_slug='bad'`)[0].n,
				0
			);
			await sql.unsafe('DROP TRIGGER fail_revision ON revisions');
			first = await save(
				payload('one', {
					id: first.id,
					version: first.version,
					aliases: [{ title: '별칭', slug: 'alias-one' }]
				})
			);
			await sql`INSERT INTO discussions (document_id,thread_title,body,editor_handle) VALUES (${first.id},'보존 토론','보존 의견','Editor-01')`;
			const trashed = (
				await sql`SELECT wv_trash_document_v1(${first.id},${first.version},'Editor-01',false) AS d`
			)[0].d;
			assert.ok(trashed.deleted_at);
			assert.deepEqual(
				(
					await sql`SELECT tag FROM wv_document_tags WHERE document_id=${first.id} ORDER BY tag`
				).map((t) => t.tag),
				['시험', '확인']
			);
			await assert.rejects(() => save(payload('alias-one')), /name_conflict/);
			const restored = (
				await sql`SELECT wv_trash_document_v1(${first.id},${trashed.version},'Editor-01',true) AS d`
			)[0].d;
			assert.equal(restored.deleted_at, null);
			assert.equal(String(restored.id), String(first.id));
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM discussions WHERE document_id=${first.id}`)[0].n,
				1
			);
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM redirects WHERE document_id=${first.id}`)[0].n,
				1
			);
			const [draft] =
				await sql`INSERT INTO drafts (title,slug,content) VALUES ('published','published','검토한 초안') RETURNING id,updated_at::text AS version`;
			const published = await Promise.allSettled(
				[1, 2].map(
					() =>
						sql`SELECT wv_publish_draft_v1(${draft.id},${draft.version},'Editor-01','{"passed":true}'::jsonb)`
				)
			);
			assert.equal(published.filter((r) => r.status === 'fulfilled').length, 1);
			assert.equal(
				(
					await sql`SELECT count(*)::int AS n FROM revisions r JOIN documents d ON d.id=r.document_id WHERE d.slug='published'`
				)[0].n,
				1
			);
			assert.equal(
				(await sql`SELECT status FROM drafts WHERE id=${draft.id}`)[0].status,
				'published'
			);
			let target = await save(
				payload('merge-target', { content: '점검 주기는 7일입니다. 파란 보관함에 보관합니다.' })
			);
			const [incoming] =
				await sql`INSERT INTO drafts (title,slug,content,aliases,source_name) VALUES ('merge-incoming','merge-incoming','점검 주기는 3일입니다.','["merge-alias"]','테스트 원문') RETURNING *`;
			const plan = {
				id: 'test-plan',
				targetId: target.id,
				targetVersion: target.version,
				previousContent: target.content,
				content: '점검 주기는 3일입니다. 파란 보관함에 보관합니다.',
				summary: '주기 갱신',
				conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }],
				draftFingerprint: draftFingerprint(incoming)
			};
			let [version] =
				await sql`UPDATE drafts SET governance=${sql.json({ merge: plan })},updated_at=clock_timestamp() WHERE id=${incoming.id} RETURNING updated_at::text AS version`;
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM revisions WHERE document_id=${target.id}`)[0].n,
				1,
				'preparing plan does not revise document'
			);
			const mergePayload = () => ({
				draftId: incoming.id,
				version: version.version,
				mergeId: plan.id,
				draftFingerprint: plan.draftFingerprint,
				content: plan.content + ' 검토자가 확인했습니다.',
				editor: 'Editor-01',
				inspection: { passed: true },
				aliases: [{ title: 'merge-alias', slug: 'merge-alias' }]
			});
			target = await save(
				payload('merge-target', {
					id: target.id,
					version: target.version,
					content: target.content + ' 추가 변경'
				})
			);
			await assert.rejects(
				() => sql`SELECT wv_apply_draft_merge_v1(${sql.json(mergePayload())})`,
				/version_conflict/
			);
			plan.targetVersion = target.version;
			[version] =
				await sql`UPDATE drafts SET governance=${sql.json({ merge: plan })},updated_at=clock_timestamp() WHERE id=${incoming.id} RETURNING updated_at::text AS version`;
			await sql.unsafe(
				'CREATE TRIGGER fail_revision BEFORE INSERT ON revisions FOR EACH ROW EXECUTE FUNCTION fail_revision()'
			);
			await assert.rejects(
				() => sql`SELECT wv_apply_draft_merge_v1(${sql.json(mergePayload())})`,
				/injected_failure/
			);
			assert.equal(
				(await sql`SELECT status FROM drafts WHERE id=${incoming.id}`)[0].status,
				'review'
			);
			assert.equal(
				(await sql`SELECT content FROM documents WHERE id=${target.id}`)[0].content,
				target.content
			);
			await sql.unsafe('DROP TRIGGER fail_revision ON revisions');
			const merged = await Promise.allSettled(
				[1, 2].map(() => sql`SELECT wv_apply_draft_merge_v1(${sql.json(mergePayload())}) AS d`)
			);
			assert.equal(merged.filter((r) => r.status === 'fulfilled').length, 1);
			const [latest] =
				await sql`SELECT details,content FROM revisions WHERE document_id=${target.id} ORDER BY id DESC LIMIT 1`;
			assert.deepEqual(latest.details.conflicts, plan.conflicts);
			assert.equal(latest.details.manuallyEdited, true);
			assert.match(latest.content, /파란 보관함/);
			assert.equal(
				(await sql`SELECT document_id FROM redirects WHERE alias_slug='merge-alias'`)[0]
					.document_id,
				String(target.id)
			);
			const [job] =
				await sql`INSERT INTO wv_upload_jobs(owner_hash,request_key,file_hash,file_name,file_size,mode,attempt,state) VALUES('fixture-owner','fixture-key','fixture-hash','fixture.docx',10,'basic','attempt-one','saving') RETURNING id`;
			const batch = {
				jobId: job.id,
				attempt: 'attempt-one',
				editor: 'Editor-01',
				mode: 'basic',
				links: 0,
				semanticSkipped: true,
				records: [
					{
						title: 'batch-one',
						slug: 'batch-one',
						content: '원문 기반 안전한 본문',
						aliases: [],
						governance: { passed: true },
						status: 'review',
						field: '일반',
						description: '설명',
						links: 0
					},
					{
						title: 'batch-two',
						slug: 'batch-two',
						content: '다른 안전한 본문',
						aliases: [],
						governance: { passed: true },
						status: 'review',
						field: '일반',
						description: '설명',
						links: 0
					}
				]
			};
			await sql.unsafe(
				"CREATE FUNCTION fail_second_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.slug='batch-two' THEN RAISE EXCEPTION 'injected_batch_failure'; END IF; RETURN NEW; END $$"
			);
			await sql.unsafe(
				'CREATE TRIGGER fail_second_draft BEFORE INSERT ON drafts FOR EACH ROW EXECUTE FUNCTION fail_second_draft()'
			);
			await assert.rejects(
				() => sql`SELECT wv_finish_upload_v1(${sql.json(batch)})`,
				/injected_batch_failure/
			);
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM drafts WHERE wv_upload_job_id=${job.id}`)[0].n,
				0,
				'partial upload batch rolled back'
			);
			assert.equal(
				(await sql`SELECT state FROM wv_upload_jobs WHERE id=${job.id}`)[0].state,
				'saving'
			);
			await sql.unsafe('DROP TRIGGER fail_second_draft ON drafts');
			const finish = await Promise.allSettled(
				[1, 2].map(() => sql`SELECT wv_finish_upload_v1(${sql.json(batch)})`)
			);
			assert.equal(
				finish.filter((r) => r.status === 'fulfilled').length,
				1,
				'only one concurrent batch completion'
			);
			assert.equal(
				(await sql`SELECT count(*)::int AS n FROM drafts WHERE wv_upload_job_id=${job.id}`)[0].n,
				2
			);
			await assert.rejects(
				() => sql`SELECT wv_finish_upload_v1(${sql.json({ ...batch, attempt: 'stale-attempt' })})`,
				/version_conflict/
			);
			console.log(
				'Verified: migration resume/checksum rejection, tag snapshot, atomic upload batch failure and concurrent completion'
			);

			assert.deepEqual(await run(seedPrototype), { documents: 6, drafts: 1 });
			assert.equal(
				(
					await sql`SELECT count(*)::int AS n FROM documents WHERE title='교대 인수인계 체크리스트'`
				)[0].n,
				0
			);
			assert.equal(
				(await sql`SELECT governance->>'reviewState' AS state FROM documents WHERE title='RFCC'`)[0]
					.state,
				'example'
			);
			assert.equal(
				(await sql`SELECT alias_title FROM redirects WHERE alias_slug='cdu'`)[0].alias_title,
				'CDU'
			);
			await sql`UPDATE documents SET content='사용자가 편집한 예시 본문' WHERE title='RFCC'`;
			await sql`UPDATE drafts SET content='사용자가 편집한 검토 초안' WHERE title='교대 인수인계 체크리스트'`;
			assert.deepEqual(await run(seedPrototype), { documents: 0, drafts: 0 });
			assert.equal(
				(await sql`SELECT content FROM documents WHERE title='RFCC'`)[0].content,
				'사용자가 편집한 예시 본문'
			);
			assert.equal(
				(await sql`SELECT content FROM drafts WHERE title='교대 인수인계 체크리스트'`)[0].content,
				'사용자가 편집한 검토 초안'
			);
			console.log(
				'Verified prototype seed: six published, one draft, actual example labels, aliases, repeat preserves edits'
			);

			console.log(
				'Verified: legacy data, alias namespace, one-winner races, rollback, relationships, one-time publication'
			);
			console.log(
				'Verified mocked merge: stale target rejection, atomic rollback, one-time apply, incoming precedence history and preserved identity'
			);
		} finally {
			await pool.end({ timeout: 5 });
			await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
			await admin.end({ timeout: 5 });
		}
	}
);
