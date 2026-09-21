import { db } from '$lib/server/db.js';
export async function load({ url }) {
	const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
	const rows =
		await db()`SELECT d.id,d.title,d.slug,d.wv_next_review_on::text AS wv_next_review_on,d.wv_reviewed_at,u.handle AS owner,count(*) OVER() AS total FROM wv_visible_documents d LEFT JOIN wv_users u ON u.id=d.wv_owner_id WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND (d.wv_next_review_on<(NOW() AT TIME ZONE 'Asia/Seoul')::date OR COALESCE(d.governance->>'reviewState','needs_review')='needs_review') ORDER BY d.wv_next_review_on NULLS LAST,d.id LIMIT 20 OFFSET ${(page - 1) * 20}`;
	return { rows, page, total: Number(rows[0]?.total || 0) };
}
