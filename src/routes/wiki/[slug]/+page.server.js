import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, renderWiki, buildToc } from '$lib/server/wiki.js';
import { getCatalog } from '$lib/server/catalog.js';

export async function load({ params }) {
	let result;
	try {
		result = await getDocument(params.slug);
	} catch {
		error(503, '문서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
	}
	if (!result) return { missing: true, slug: params.slug };
	const { document, redirectedFrom } = result;
	const sql = db();
	const [html, catalog, threads, contributors] = await Promise.all([
		renderWiki(document.content),
		getCatalog(),
		sql`SELECT count(*) AS count FROM discussions WHERE document_id=${document.id}`,
		sql`SELECT count(DISTINCT editor_handle) AS count FROM revisions WHERE document_id=${document.id}`
	]);
	const enriched = catalog.documents.find((doc) => doc.slug === document.slug);
	return {
		missing: false,
		document: enriched,
		redirectedFrom,
		html,
		toc: buildToc(document.content),
		threads: Number(threads[0].count),
		contributors: Number(contributors[0].count)
	};
}
