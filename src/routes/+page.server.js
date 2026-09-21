import { db } from '$lib/server/db.js';
export async function load({ url }) {
	const q = url.searchParams.get('q')?.trim() || '';
	try {
		const sql = db();
		const [announcements, discussions, changes, results] = await Promise.all([
			sql`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5`,
			sql`SELECT ds.*,d.slug,d.title AS document_title FROM discussions ds JOIN documents d ON d.id=ds.document_id ORDER BY ds.created_at DESC LIMIT 6`,
			sql`SELECT slug,title,editor_handle,updated_at FROM documents ORDER BY updated_at DESC LIMIT 10`,
			q ? sql`SELECT DISTINCT d.slug,d.title,d.updated_at FROM documents d LEFT JOIN redirects r ON r.document_id=d.id WHERE d.title ILIKE ${'%' + q + '%'} OR d.content ILIKE ${'%' + q + '%'} OR r.alias_title ILIKE ${'%' + q + '%'} ORDER BY d.updated_at DESC LIMIT 20` : []
		]);
		return { q, announcements, discussions, changes, results, databaseReady: true };
	} catch (error) { return { q, announcements: [], discussions: [], changes: [], results: [], databaseReady: false, error: error.message }; }
}
