import { db } from '$lib/server/db.js';
export async function load({ url }) {
	const kind = ['orphan', 'missing', 'source'].includes(url.searchParams.get('kind'))
		? url.searchParams.get('kind')
		: 'orphan';
	const page = Math.min(10000, Math.max(1, Number.parseInt(url.searchParams.get('page')) || 1));
	try {
		const sql = db();
		const rows = await sql`SELECT d.id,d.title,d.slug,d.source_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('slug',l.target_slug,'title',l.target_title)) FROM wv_document_links l WHERE l.document_id=d.id AND NOT EXISTS(SELECT 1 FROM wv_current_documents t LEFT JOIN wv_resolved_names r ON r.document_id=t.id WHERE t.deleted_at IS NULL AND t.wv_archived_at IS NULL AND (t.slug=l.target_slug OR r.alias_slug=l.target_slug))),'[]'::jsonb) AS missing,
      count(*) OVER() AS total
      FROM wv_current_documents d WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND
      ((${kind}='source' AND COALESCE(trim(d.source_name),'')='') OR (${kind}='orphan' AND NOT EXISTS(SELECT 1 FROM wv_link_edges e WHERE e.source_id=d.id OR e.target_id=d.id)) OR
      (${kind}='missing' AND EXISTS(SELECT 1 FROM wv_document_links l WHERE l.document_id=d.id AND NOT EXISTS(SELECT 1 FROM wv_current_documents t LEFT JOIN wv_resolved_names r ON r.document_id=t.id WHERE t.deleted_at IS NULL AND t.wv_archived_at IS NULL AND (t.slug=l.target_slug OR r.alias_slug=l.target_slug)))))
      ORDER BY d.updated_at DESC,d.id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
		return { kind, page, rows, total: Number(rows[0]?.total || 0), problem: '' };
	} catch {
		return {
			kind,
			page,
			rows: [],
			total: 0,
			problem: '점검 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
		};
	}
}
