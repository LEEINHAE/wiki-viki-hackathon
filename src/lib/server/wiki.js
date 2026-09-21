import { db } from './db.js';
import { renderWikiHtml } from '../wiki-renderer.js';
export { buildToc } from '../wiki-renderer.js';

export function slugify(value) {
	return value
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/[^\p{L}\p{N}:.~-]/gu, '')
		.replace(/-+/g, '-')
		.toLowerCase();
}

export async function getDocument(slug, { followMerges = true, includeDeleted = false } = {}) {
	const sql = db();
	const [direct] =
		await sql`SELECT d.*,d.wv_next_review_on::text AS wv_next_review_on,d.updated_at::text AS version FROM wv_visible_documents d WHERE (${includeDeleted} OR deleted_at IS NULL) AND slug=${slug} LIMIT 1`;
	const [alias] = !direct
		? await sql`SELECT d.*,d.wv_next_review_on::text AS wv_next_review_on,d.updated_at::text AS version,r.title AS alias_title FROM (SELECT document_id,alias_slug AS slug,alias_title AS title FROM redirects UNION SELECT document_id,slug,title FROM wv_preserved_routes WHERE wv_role_rank_v1(wv_min_role)<=(SELECT wv_actor_rank_v1())) r JOIN wv_visible_documents d ON d.id=r.document_id WHERE (${includeDeleted} OR d.deleted_at IS NULL) AND r.slug=${slug} LIMIT 1`
		: [];
	let document = direct || alias;
	if (!document) return null;
	let mergedFrom = null;
	if (followMerges && document.wv_merged_into) {
		const original = document;
		const [target] =
			await sql`SELECT d.*,d.wv_next_review_on::text AS wv_next_review_on,d.updated_at::text AS version FROM wv_document_roots r JOIN wv_current_documents d ON d.id=r.target_id WHERE r.source_id=${document.id}`;
		if (!target) return null;
		document = target;
		mergedFrom = { slug: original.slug, title: original.title };
	}
	delete document.wv_search_text;
	return { document, redirectedFrom: alias?.alias_title || null, mergedFrom };
}

export async function recentChanges(limit = 12) {
	return db()`SELECT slug, title, editor_handle, updated_at FROM wv_visible_documents WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${limit}`;
}

export async function renderWiki(content) {
	const sql = db();
	const names = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) =>
		match[1].trim()
	);
	let known = new Set();
	let pending = new Map();
	if (names.length) {
		const slugs = names.map(slugify);
		const rows =
			await sql`SELECT alias_slug AS slug FROM wv_resolved_names WHERE alias_slug=ANY(${slugs})`;
		known = new Set(rows.map((row) => row.slug));
		const drafts =
			await sql`SELECT id,slug FROM wv_visible_drafts WHERE slug=ANY(${slugs}) AND status <> 'published' ORDER BY created_at`;
		pending = new Map(drafts.map((row) => [row.slug, row.id]));
	}
	return renderWikiHtml(content, { known, pending });
}

export async function autoLinkDocument(content, suggestions = []) {
	const terms = [
		...new Set(suggestions.map((term) => term.trim()).filter((term) => term.length > 2))
	].slice(0, 20);
	if (!terms.length) return content;
	const sql = db();
	// const rows =
	// 	await sql`SELECT title FROM wv_current_documents WHERE deleted_at IS NULL AND wv_archived_at IS NULL AND LOWER(title) IN ${sql(terms.map((term) => term.toLowerCase()))}`;
	const lowerTerms = terms.map((term) => term.toLowerCase());
	const rows =
		await sql`SELECT title FROM wv_current_documents WHERE deleted_at IS NULL AND wv_archived_at IS NULL AND LOWER(title) = ANY(${lowerTerms})`;
	let linked = content;
	for (const { title } of rows) {
		if (linked.includes(`[[${title}`)) continue;
		const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		linked = linked.replace(
			new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?![^[]*\\]\\])`, 'u'),
			`[[${title}]]`
		);
	}
	return linked;
}
