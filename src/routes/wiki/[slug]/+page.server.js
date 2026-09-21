import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, renderWiki, buildToc } from '$lib/server/wiki.js';
import { buildKnowledgeGraph, categoryOf, documentSummary, slugify } from '$lib/knowledge.js';

export async function load({ params }) {
	let result;
	try {
		result = await getDocument(params.slug);
	} catch {
		error(503, '문서를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.');
	}
	if (!result) {
		const [pendingDraft] =
			await db()`SELECT id,title,status FROM drafts WHERE slug=${slugify(params.slug)} AND status <> 'published' ORDER BY updated_at DESC,id DESC LIMIT 1`;
		return { missing: true, slug: params.slug, pendingDraft: pendingDraft || null };
	}
	const { document, redirectedFrom } = result;
	const sql = db();
	const [html, documents, aliases, counts] = await Promise.all([
		renderWiki(document.content),
		sql`SELECT id,slug,title,content,editor_handle,updated_at FROM documents`,
		sql`SELECT alias_slug,alias_title,document_id FROM redirects`,
		sql`SELECT (SELECT COUNT(*)::int FROM discussions WHERE document_id=${document.id}) AS threads, (SELECT COUNT(DISTINCT editor_handle)::int FROM revisions WHERE document_id=${document.id}) AS contributors`
	]);
	const graph = buildKnowledgeGraph(documents, aliases);
	const incoming = new Set(
		graph.allEdges.filter((edge) => edge.target === document.slug).map((edge) => edge.source)
	);
	const outgoing = new Set(
		graph.allEdges.filter((edge) => edge.source === document.slug).map((edge) => edge.target)
	);
	return {
		missing: false,
		document,
		redirectedFrom,
		html,
		toc: buildToc(document.content),
		category: categoryOf(document),
		aliases: aliases
			.filter((alias) => String(alias.document_id) === String(document.id))
			.map((alias) => alias.alias_title),
		backlinks: documents.filter((doc) => incoming.has(doc.slug)).map(documentSummary),
		related: documents.filter((doc) => outgoing.has(doc.slug)).map(documentSummary),
		...counts[0]
	};
}
