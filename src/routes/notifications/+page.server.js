import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
export async function load({ locals, url }) {
	if (!locals.user) redirect(303, '/login');
	const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
	const unread = url.searchParams.get('unread') === '1';
	const rows =
		await db()`SELECT n.id,n.kind,n.proposal_id,n.discussion_id,n.revision_id,n.read_at,n.created_at,d.slug,d.title,u.handle AS actor,count(*) OVER() AS total FROM wv_notifications n JOIN wv_visible_documents d ON d.id=n.document_id LEFT JOIN wv_users u ON u.id=n.actor_id WHERE n.user_id=${locals.user.id} AND wv_role_rank_v1(n.wv_min_role)<=(SELECT wv_actor_rank_v1()) AND (n.revision_id IS NULL OR EXISTS(SELECT 1 FROM wv_visible_revisions r WHERE r.id=n.revision_id)) AND (n.proposal_id IS NULL OR EXISTS(SELECT 1 FROM wv_visible_proposals p WHERE p.id=n.proposal_id)) AND (n.discussion_id IS NULL OR EXISTS(SELECT 1 FROM wv_visible_discussions t WHERE t.id=n.discussion_id)) AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND (NOT ${unread} OR n.read_at IS NULL) ORDER BY n.created_at DESC,n.id DESC LIMIT 30 OFFSET ${(page - 1) * 30}`;
	return { rows, page, unread, total: Number(rows[0]?.total || 0) };
}
export const actions = {
	read: async ({ locals, request }) => {
		if (!locals.user) redirect(303, '/login');
		const form = await request.formData();
		const id = String(form.get('id') || '');
		if (/^\d+$/.test(id))
			await db()`UPDATE wv_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=${id}::bigint AND user_id=${locals.user.id}`;
		redirect(303, '/notifications');
	}
};
