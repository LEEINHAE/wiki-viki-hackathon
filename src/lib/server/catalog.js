import { db } from './db.js';
import { excerpt, slugify, wikiTargets } from '$lib/wiki-utils.js';

export async function getCatalog({ drafts = false } = {}) {
	const sql = db();
	const [documents, redirects, pending] = await Promise.all([
		sql`SELECT * FROM documents ORDER BY updated_at DESC`,
		sql`SELECT alias_title, alias_slug, document_id FROM redirects`,
		drafts ? sql`SELECT * FROM drafts WHERE status <> 'published' ORDER BY created_at DESC` : []
	]);
	const catalog = documents.map((doc) => ({
		...doc,
		field: doc.field || '일반',
		description: doc.description || excerpt(doc.content),
		isDraft: false,
		aliases: redirects
			.filter((alias) => String(alias.document_id) === String(doc.id))
			.map((alias) => alias.alias_title),
		targets: wikiTargets(doc.content),
		backlinks: []
	}));
	const bySlug = new Map(catalog.map((doc) => [doc.slug, doc]));
	for (const alias of redirects) {
		const doc = catalog.find((doc) => String(doc.id) === String(alias.document_id));
		if (doc) bySlug.set(alias.alias_slug, doc);
	}
	const edges = [];
	const missing = new Map();
	for (const doc of catalog) {
		doc.related = [];
		for (const title of doc.targets) {
			const target = bySlug.get(slugify(title));
			if (target && target.id !== doc.id) {
				if (!doc.related.some((item) => item.slug === target.slug)) {
					doc.related.push({ slug: target.slug, title: target.title, field: target.field });
					target.backlinks.push({ slug: doc.slug, title: doc.title });
					edges.push({ from: doc.slug, to: target.slug });
				}
			} else if (!target) missing.set(slugify(title), { title, slug: slugify(title) });
		}
	}
	const draftDocs = pending.map((doc) => ({
		...doc,
		isDraft: true,
		description: doc.description || excerpt(doc.content),
		field: doc.field || '일반',
		targets: wikiTargets(doc.content),
		backlinks: [],
		related: []
	}));
	return { documents: catalog, drafts: draftDocs, edges, missing: [...missing.values()] };
}
