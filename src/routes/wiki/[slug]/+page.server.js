import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, recentChanges, renderWiki, buildToc } from '$lib/server/wiki.js';

export async function load({ params }) {
	let result;
	try { result = await getDocument(params.slug); } catch (cause) { error(503, `데이터베이스를 사용할 수 없습니다: ${cause.message}`); }
	if (!result) return { missing: true, slug: params.slug, changes: await recentChanges() };
	const { document, redirectedFrom } = result;
	const sql = db();
	const [html, changes, backlinks] = await Promise.all([
		renderWiki(document.content), recentChanges(),
		sql`SELECT slug,title FROM documents WHERE id <> ${document.id} AND content ILIKE ${'%[[' + document.title + '%'} ORDER BY title LIMIT 50`
	]);
	return { missing: false, document, redirectedFrom, html, toc: buildToc(document.content), changes, backlinks };
}
