import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { readLinkSnapshot } from '$lib/server/document-links.js';
import { getDocument, renderWiki, buildToc } from '$lib/server/wiki.js';
import { getEditableDocument } from '$lib/server/document-write.js';
import { documentConnections, categoryOf, slugify } from '$lib/knowledge.js';

export async function load({ params }) {
	let result;
	try {
		result = await getDocument(params.slug);
	} catch {
		error(503, '문서를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.');
	}
	if (!result) {
		const archived = await getEditableDocument(params.slug, null, { includeDeleted: true });
		if (archived?.document.deleted_at)
			return {
				missing: true,
				trashed: true,
				trashId: archived.document.id,
				slug: params.slug,
				pendingDraft: null
			};
		const [pendingDraft] =
			await db()`SELECT id,title,status FROM drafts WHERE slug=${slugify(params.slug)} AND status <> 'published' ORDER BY updated_at DESC,id DESC LIMIT 1`;
		return { missing: true, slug: params.slug, pendingDraft: pendingDraft || null };
	}
	const { document, redirectedFrom } = result;
	const sql = db();
	const [snapshot, counts] = await Promise.all([
		readLinkSnapshot({ content: true }),
		sql`SELECT (SELECT COUNT(*)::int FROM discussions WHERE document_id=${document.id}) AS threads, (SELECT COUNT(DISTINCT editor_handle)::int FROM revisions WHERE document_id=${document.id}) AS contributors`
	]);
	const { documents, aliases, catalog } = snapshot;
	const html = await renderWiki(document.content, [], {}, { sourceSlug: document.slug, catalog });
	const connections = documentConnections(document, documents, catalog);
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
		...connections,
		...counts[0]
	};
}
