import { db } from './db.js';
export async function documentRelations(id) {
	const sql = db();
	const [aliases, related, backlinks, tags] = await Promise.all([
		sql`SELECT alias_title FROM redirects WHERE document_id=${id} ORDER BY alias_title`,
		sql`SELECT e.target_slug AS slug,e.target_title AS title,d.field FROM wv_link_edges e JOIN wv_current_documents d ON d.id=e.target_id WHERE e.source_id=${id} ORDER BY e.target_title LIMIT 100`,
		sql`SELECT source_slug AS slug,source_title AS title FROM wv_link_edges WHERE target_id=${id} ORDER BY source_title LIMIT 100`,
		sql`SELECT tag FROM wv_document_tags WHERE document_id=${id} ORDER BY tag`
	]);
	return {
		aliases: aliases.map((a) => a.alias_title),
		related,
		backlinks,
		tags: tags.map((t) => t.tag)
	};
}
export async function homeSummary() {
	const sql = db();
	const [stats, changes, trending, drafts, announcements, discussions, missing] = await Promise.all(
		[
			sql`SELECT (SELECT count(*) FROM wv_current_documents WHERE deleted_at IS NULL AND wv_archived_at IS NULL) AS documents,
      (SELECT count(*) FROM wv_visible_revisions r JOIN wv_current_documents d ON d.id=r.document_id WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND r.created_at >= (date_trunc('week',NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')) AS edits,
      (SELECT count(*) FROM wv_link_edges) AS links,(SELECT count(*) FROM wv_visible_drafts WHERE status<>'published') AS drafts`,
			sql`SELECT d.id,d.slug,d.title,d.editor_handle,d.updated_at,COALESCE((SELECT summary FROM wv_visible_revisions r WHERE r.document_id=d.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'') AS summary FROM wv_current_documents d WHERE deleted_at IS NULL AND wv_archived_at IS NULL ORDER BY updated_at DESC LIMIT 12`,
			sql`SELECT d.id,d.slug,d.title,d.field,count(e.source_id)::int AS backlink_count FROM wv_current_documents d LEFT JOIN wv_link_edges e ON e.target_id=d.id WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL GROUP BY d.id,d.slug,d.title,d.field ORDER BY backlink_count DESC,d.title LIMIT 7`,
			sql`SELECT id,title,slug,source_name,status FROM wv_visible_drafts WHERE status<>'published' ORDER BY created_at DESC LIMIT 3`,
			sql`SELECT id,title,left(body,300) AS body,created_at FROM announcements ORDER BY created_at DESC LIMIT 4`,
			sql`SELECT t.id,t.thread_title,t.created_at,d.slug,d.title FROM wv_visible_discussions t JOIN wv_current_documents d ON d.id=t.document_id WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL ORDER BY t.created_at DESC,t.id DESC LIMIT 5`,
			sql`SELECT l.target_slug AS slug,min(l.target_title) AS title,count(DISTINCT l.document_id)::int AS count FROM wv_document_links l JOIN wv_current_documents d ON d.id=l.document_id AND d.deleted_at IS NULL
      WHERE NOT EXISTS(SELECT 1 FROM wv_current_documents t WHERE t.slug=l.target_slug AND t.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM wv_resolved_names r JOIN wv_current_documents t ON t.id=r.document_id WHERE r.alias_slug=l.target_slug AND t.deleted_at IS NULL)
      GROUP BY l.target_slug ORDER BY count DESC,slug LIMIT 100`
		]
	);
	return {
		stats: Object.fromEntries(Object.entries(stats[0]).map(([k, v]) => [k, Number(v)])),
		changes,
		trending,
		hubs: trending,
		drafts: drafts.map((d) => ({ ...d, isDraft: true })),
		announcements,
		discussions,
		missing
	};
}
export async function knowledgeGraph({ center = '', field = '' } = {}) {
	const sql = db();
	const [root] = center
		? await sql`SELECT id,slug,title,field FROM wv_current_documents WHERE deleted_at IS NULL AND wv_archived_at IS NULL AND slug=${center}`
		: await sql`SELECT d.id,d.slug,d.title,d.field FROM wv_current_documents d LEFT JOIN wv_link_edges e ON e.target_id=d.id WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND (${field}='' OR d.field=${field}) GROUP BY d.id,d.slug,d.title,d.field ORDER BY count(e.source_id) DESC,d.title LIMIT 1`;
	if (!root) return { documents: [], edges: [], center: '' };
	const neighbors = await sql`SELECT d.id,d.slug,d.title,d.field,
    EXISTS(SELECT 1 FROM wv_link_edges e WHERE e.source_id=${root.id} AND e.target_id=d.id) AS outgoing,
    EXISTS(SELECT 1 FROM wv_link_edges e WHERE e.target_id=${root.id} AND e.source_id=d.id) AS incoming
    FROM wv_current_documents d WHERE deleted_at IS NULL AND wv_archived_at IS NULL AND id<>${root.id} AND (${field}='' OR d.field=${field}) AND EXISTS(SELECT 1 FROM wv_link_edges e WHERE (e.source_id=${root.id} AND e.target_id=d.id) OR (e.target_id=${root.id} AND e.source_id=d.id)) ORDER BY d.title LIMIT 6`;
	const ids = [root.id, ...neighbors.map((d) => d.id)];
	const edges =
		await sql`SELECT source_slug AS "from",target_slug AS "to" FROM wv_link_edges WHERE source_id=ANY(${ids}::bigint[]) AND target_id=ANY(${ids}::bigint[])`;
	return { documents: [root, ...neighbors], edges, center: root.slug };
}
