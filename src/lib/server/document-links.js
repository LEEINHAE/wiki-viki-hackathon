import { db } from './db.js';
import { createLinkCatalog, linkedWikiTokens } from '../wiki-links.js';

// One statement keeps the documents and their aliases in the same database snapshot.
export async function readLinkSnapshot({ content = false } = {}) {
	const sql = db();
	const rows = content
		? await sql`SELECT d.id::text AS id,d.slug,d.title,d.content,d.editor_handle,d.updated_at,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('alias_slug',r.alias_slug,'alias_title',r.alias_title)) FROM redirects r WHERE r.document_id=d.id AND NOT EXISTS(SELECT 1 FROM documents reserved WHERE reserved.slug=r.alias_slug AND reserved.deleted_at IS NOT NULL)),'[]'::jsonb) AS link_aliases
			FROM documents d WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC,d.id DESC`
		: await sql`SELECT d.id::text AS id,d.slug,d.title,
			COALESCE((SELECT jsonb_agg(jsonb_build_object('alias_slug',r.alias_slug,'alias_title',r.alias_title)) FROM redirects r WHERE r.document_id=d.id AND NOT EXISTS(SELECT 1 FROM documents reserved WHERE reserved.slug=r.alias_slug AND reserved.deleted_at IS NOT NULL)),'[]'::jsonb) AS link_aliases
			FROM documents d WHERE d.deleted_at IS NULL`;
	const aliases = rows.flatMap((document) =>
		(document.link_aliases || []).map((alias) => ({ ...alias, document_id: document.id }))
	);
	return { documents: rows, aliases, catalog: createLinkCatalog(rows, aliases) };
}

export async function inspectDocumentLinks(url) {
	const { documents, catalog } = await readLinkSnapshot({ content: true });
	const incoming = new Map(documents.map((document) => [document.slug, 0]));
	const names = new Map(documents.map((document) => [document.slug, document.title]));
	let automatic = 0,
		total = 0;
	const rows = documents.map((document) => {
		const { connections, missing } = linkedWikiTokens(document.content, catalog, {
			sourceSlug: document.slug
		});
		for (const connection of connections) {
			incoming.set(connection.target, incoming.get(connection.target) + 1);
			if (connection.automatic) automatic++;
			total++;
		}
		return {
			slug: document.slug,
			title: document.title,
			connections: connections.map((connection) => ({
				...connection,
				title: names.get(connection.target)
			})),
			missing
		};
	});
	for (const row of rows) row.incoming = incoming.get(row.slug);
	const pages = Math.max(1, Math.ceil(rows.length / 20));
	const requested = Number(url.searchParams.get('page') || 1);
	const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1;
	return {
		checkedAt: new Date().toISOString(),
		documents: documents.length,
		automatic,
		total,
		unresolved: rows.reduce((sum, row) => sum + row.missing.length, 0),
		isolated: rows.filter((row) => !row.incoming && !row.connections.length).length,
		ambiguous: catalog.ambiguous,
		page,
		pages,
		rows: rows.slice((page - 1) * 20, page * 20)
	};
}
