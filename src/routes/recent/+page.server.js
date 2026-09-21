import { db } from '$lib/server/db.js';
export async function load({ url }) {
	const page = Math.max(1, Math.min(10000, Math.floor(Number(url.searchParams.get('page')) || 1)));
	try {
		const sql = db();
		const changes =
			await sql`SELECT r.id,r.summary,r.editor_handle,r.created_at,d.slug,d.title FROM revisions r JOIN documents d ON d.id=r.document_id ORDER BY r.created_at DESC,r.id DESC LIMIT 31 OFFSET ${(page - 1) * 30}`;
		return { changes: changes.slice(0, 30), page, more: changes.length > 30 };
	} catch {
		return { changes: [], page, more: false, problem: '변경 내역을 불러오지 못했습니다.' };
	}
}
