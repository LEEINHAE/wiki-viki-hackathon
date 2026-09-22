import { reviewVersion } from './draft-publication.js';
import { slugify } from '../knowledge.js';

export const validDraftId = (id) =>
	/^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
export const validDraftVersion = (version) => /^[a-f0-9]{64}$/.test(version);

export async function getDraft(sql, id) {
	const [draft] =
		await sql`SELECT d.*, (to_jsonb(d) - 'id')::text AS snapshot FROM drafts d WHERE id=${id}`;
	return draft ? { ...draft, version: reviewVersion(draft.snapshot) } : null;
}

export async function deleteDraftBatch(sql, drafts) {
	const requested = JSON.stringify(
		drafts.map(({ id, snapshot }) => ({ id: String(id), snapshot }))
	);
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			// Stable lock order prevents overlapping selections from deadlocking.
			tx`SELECT d.id FROM drafts d
				JOIN jsonb_to_recordset(${requested}::jsonb) AS r(id bigint, snapshot text) ON r.id=d.id
				ORDER BY d.id FOR UPDATE OF d`,
			// Read a fresh snapshot after waiting for editors or publishers.
			// The count guard also rolls back if a trigger silently skips a deletion.
			tx`WITH requested AS MATERIALIZED (
				SELECT * FROM jsonb_to_recordset(${requested}::jsonb) AS r(id bigint, snapshot text)
			), eligible AS MATERIALIZED (
				SELECT d.id FROM drafts d JOIN requested r ON d.id=r.id
				WHERE d.status<>'published' AND (to_jsonb(d)-'id')=r.snapshot::jsonb
			), changed AS (
				DELETE FROM drafts WHERE id IN (SELECT id FROM eligible)
					AND (SELECT count(*) FROM eligible)=${drafts.length}
				RETURNING id
			)
			SELECT (SELECT count(*) FROM changed) AS deleted,
				1 / CASE WHEN (SELECT count(*) FROM changed)=
					CASE WHEN (SELECT count(*) FROM eligible)=${drafts.length} THEN ${drafts.length} ELSE 0 END
				THEN 1 ELSE 0 END AS atomic_guard`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return Number(results.at(-1)[0].deleted) === drafts.length;
}

// Inspection runs before this transaction. Lock one row, then recheck its exact
// database snapshot in a fresh statement before changing or deleting anything.
export async function changeDraft(sql, draft, values = null, governance = null) {
	const savedGovernance = { ...draft.governance, ...governance };
	delete savedGovernance.merge;
	delete savedGovernance.publication;
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			tx`SELECT id FROM drafts WHERE id=${draft.id} FOR UPDATE`,
			values
				? tx`WITH eligible AS MATERIALIZED (
			SELECT id FROM drafts d WHERE id=${draft.id} AND status<>'published'
				AND (to_jsonb(d)-'id')=${draft.snapshot}::jsonb
		), changed AS (
			UPDATE drafts SET title=${values.title},slug=${slugify(values.title)},content=${values.content},
				aliases=${JSON.stringify(values.aliases)}::jsonb,editor_handle=${values.editor},
				governance=${JSON.stringify(savedGovernance)}::jsonb,status=${governance.passed ? 'review' : 'blocked'},updated_at=NOW()
			WHERE id IN (SELECT id FROM eligible) RETURNING id
		)
		SELECT EXISTS(SELECT 1 FROM changed) AS changed,
			1 / CASE WHEN (SELECT count(*) FROM eligible)=(SELECT count(*) FROM changed) THEN 1 ELSE 0 END AS atomic_guard`
				: tx`WITH eligible AS MATERIALIZED (
			SELECT id FROM drafts d WHERE id=${draft.id} AND status<>'published'
				AND (to_jsonb(d)-'id')=${draft.snapshot}::jsonb
		), changed AS (
			DELETE FROM drafts WHERE id IN (SELECT id FROM eligible) RETURNING id
		)
		SELECT EXISTS(SELECT 1 FROM changed) AS changed,
			1 / CASE WHEN (SELECT count(*) FROM eligible)=(SELECT count(*) FROM changed) THEN 1 ELSE 0 END AS atomic_guard`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return results.at(-1)[0].changed;
}
