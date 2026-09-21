import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import {
	draftFingerprint,
	applyMergedDraft,
	publishNewDraft
} from '../src/lib/server/draft-publishing.js';

// Explicit opt-in: tests create isolated fixtures and delete only their own IDs.
test(
	'atomic draft publishing and merge concurrency in PostgreSQL',
	{ skip: process.env.RUN_MERGE_DB_TESTS !== '1' },
	async (t) => {
		const sql = neon(process.env.DATABASE_URL);
		const ownedDocuments = [];
		const ownedDrafts = [];
		const prefix = `merge-test-${randomUUID()}`;
		let count = 0;
		const readDraft = async (id) =>
			(await sql`SELECT *,updated_at::text AS version FROM drafts WHERE id=${id}`)[0];
		async function fixture() {
			const title = `${prefix}-${++count}`;
			const [target] =
				await sql`INSERT INTO documents (title,slug,content,editor_handle) VALUES (${title},${title},'점검 주기는 7일입니다. 인계 노트는 보관함에 둡니다.','Editor-99') RETURNING *,updated_at::text AS version`;
			ownedDocuments.push(target.id);
			await sql`INSERT INTO revisions (document_id,content,editor_handle,summary) VALUES (${target.id},${target.content},'Editor-99','검증용 원본')`;
			const [draft] =
				await sql`INSERT INTO drafts (title,slug,content,editor_handle,source_name) VALUES (${title},${title},'점검 주기는 3일입니다. 결과는 점검표에 기록합니다.','Editor-99',${prefix}) RETURNING *`;
			ownedDrafts.push(draft.id);
			const proposal = {
				id: randomUUID(),
				target: { id: target.id, slug: target.slug, title: target.title, version: target.version },
				draftFingerprint: draftFingerprint(draft),
				baseContent: target.content,
				content: '점검 주기는 3일입니다. 인계 노트는 보관함에 둡니다. 결과는 점검표에 기록합니다.',
				summary: '점검 주기 변경 및 결과 기록 추가',
				conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }]
			};
			await sql`UPDATE drafts SET governance=${JSON.stringify({ merge: proposal })}::jsonb,updated_at=NOW() WHERE id=${draft.id}`;
			return { target, draft: await readDraft(draft.id), proposal };
		}
		try {
			await t.test('duplicate publication never overwrites an existing document', async () => {
				const { target, draft } = await fixture();
				assert.equal(await publishNewDraft(sql, draft, { passed: true }), undefined);
				const [unchanged] = await sql`SELECT content FROM documents WHERE id=${target.id}`;
				assert.equal(unchanged.content, target.content);
				assert.notEqual((await readDraft(draft.id)).status, 'published');
			});
			await t.test(
				'stale original and stale draft cannot apply and do not create revisions',
				async () => {
					const { target, draft, proposal } = await fixture();
					await sql`UPDATE documents SET content='새로 편집한 원본',updated_at=NOW() WHERE id=${target.id}`;
					assert.equal(
						await applyMergedDraft(sql, draft, proposal, proposal.content, 'Editor-99', {
							passed: true
						}),
						undefined
					);
					const [unchanged] = await sql`SELECT content FROM documents WHERE id=${target.id}`;
					assert.equal(unchanged.content, '새로 편집한 원본');
					assert.equal(
						(await sql`SELECT id FROM revisions WHERE document_id=${target.id}`).length,
						1
					);
					const next = await fixture();
					await sql`UPDATE drafts SET content='수정한 초안',updated_at=NOW() WHERE id=${next.draft.id}`;
					assert.equal(
						await applyMergedDraft(
							sql,
							next.draft,
							next.proposal,
							next.proposal.content,
							'Editor-99',
							{ passed: true }
						),
						undefined
					);
					assert.equal(
						await applyMergedDraft(
							sql,
							await readDraft(next.draft.id),
							next.proposal,
							next.proposal.content,
							'Editor-99',
							{ passed: true }
						),
						null
					);
				}
			);
			await t.test(
				'concurrent merge applies exactly once, preserves old revision and records conflicts',
				async () => {
					const { target, draft, proposal } = await fixture();
					const results = await Promise.all(
						[1, 2].map(() =>
							applyMergedDraft(sql, draft, proposal, proposal.content, 'Editor-99', {
								passed: true
							})
						)
					);
					assert.equal(results.filter(Boolean).length, 1);
					const [merged] = await sql`SELECT * FROM documents WHERE id=${target.id}`;
					assert.equal(merged.content, proposal.content);
					assert.equal(merged.title, target.title);
					assert.equal(merged.slug, target.slug);
					const revisions =
						await sql`SELECT content,summary FROM revisions WHERE document_id=${target.id} ORDER BY id`;
					assert.equal(revisions.length, 2);
					assert.equal(revisions[0].content, target.content);
					assert.match(revisions[1].summary, /기존: 7일\n새 초안: 3일/);
					assert.equal((await readDraft(draft.id)).status, 'published');
				}
			);
			await t.test('new publication is atomic and never takes another document alias', async () => {
				const { target, draft } = await fixture();
				const existingAlias = `${prefix}-reserved`;
				const newAlias = `${prefix}-new-alias`;
				const newTitle = `${prefix}-published`;
				await sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES (${existingAlias},${existingAlias},${target.id})`;
				await sql`UPDATE drafts SET title=${newTitle},slug=${newTitle},aliases=${JSON.stringify([existingAlias, newAlias])}::jsonb,updated_at=NOW() WHERE id=${draft.id}`;
				const fresh = await readDraft(draft.id);
				const results = await Promise.all(
					[1, 2].map(() => publishNewDraft(sql, fresh, { passed: true }))
				);
				const created = results.filter(Boolean);
				for (const document of created) ownedDocuments.push(document.id);
				assert.equal(created.length, 1);
				assert.equal((await readDraft(draft.id)).status, 'published');
				const [preserved] =
					await sql`SELECT document_id FROM redirects WHERE alias_slug=${existingAlias}`;
				const [added] = await sql`SELECT document_id FROM redirects WHERE alias_slug=${newAlias}`;
				assert.equal(preserved.document_id, target.id);
				assert.equal(added.document_id, created[0].id);
				assert.equal(
					(await sql`SELECT id FROM revisions WHERE document_id=${created[0].id}`).length,
					1
				);
			});
		} finally {
			if (ownedDrafts.length)
				await sql`DELETE FROM drafts WHERE id=ANY(${ownedDrafts}::bigint[]) AND source_name=${prefix}`;
			if (ownedDocuments.length)
				await sql`DELETE FROM documents WHERE id=ANY(${ownedDocuments}::bigint[]) AND title LIKE ${prefix + '%'}`;
		}
	}
);
