import { db } from './db.js';

export const validDocumentId = (id) =>
	/^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
export const validDocumentVersion = (version) => /^[a-f0-9]{64}$/.test(version);

// Keep all document and relationship rows in place. The lifecycle counter also
// invalidates reviewed forms after a delete/restore round trip, without changing
// the original content edit timestamp or editor.
export async function changeDocumentTrash({ expected, deleted, editor = 'Operator-A' }) {
	if (!expected || typeof deleted !== 'boolean') throw new Error('Reviewed document is required');
	const { document, aliases, snapshot } = expected;
	// Restoration reactivates stored routes; it creates no title-derived URL or
	// new label. Legacy titles and alias labels may already belong to other URLs.
	const routes = [...new Set([document.slug, ...aliases.map((a) => a.alias_slug)])];
	const sql = db();
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`,
			tx`WITH current_state AS MATERIALIZED (
			SELECT jsonb_build_object('document',to_jsonb(d),'aliases',
				COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM redirects r WHERE r.document_id=d.id),'[]'::jsonb)) AS snapshot
			FROM documents d WHERE id=${document.id} AND (deleted_at IS NOT NULL)=${!deleted}
		), eligible AS MATERIALIZED (
			SELECT 1 FROM current_state WHERE snapshot=${snapshot}::jsonb
		), conflicts AS MATERIALIZED (
			SELECT id FROM documents WHERE ${!deleted} AND id<>${document.id}
				AND (title=${document.title} OR slug=ANY(${routes}::text[]))
			UNION ALL SELECT document_id FROM redirects WHERE ${!deleted} AND document_id<>${document.id}
				AND alias_slug=ANY(${routes}::text[])
		), allowed AS MATERIALIZED (
			SELECT 1 FROM eligible WHERE NOT EXISTS(SELECT 1 FROM conflicts)
		), changed AS (
			UPDATE documents SET deleted_at=CASE WHEN ${deleted} THEN NOW() ELSE NULL END,
				deleted_by=CASE WHEN ${deleted} THEN ${editor} ELSE NULL END,
				lifecycle_version=lifecycle_version+1
			WHERE id=${document.id} AND EXISTS(SELECT 1 FROM allowed) RETURNING id,slug
		)
		SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM eligible) THEN 'changed'
			WHEN EXISTS(SELECT 1 FROM conflicts) THEN 'conflict'
			ELSE ${deleted ? 'trashed' : 'restored'} END AS status,
			(SELECT slug FROM changed) AS slug,
			1 / CASE WHEN (SELECT count(*) FROM changed)=(SELECT count(*) FROM allowed) THEN 1 ELSE 0 END AS atomic_guard`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return results.at(-1)[0];
}
