import { db } from './db.js';
import { marked } from 'marked';

import { slugify, linkTerms } from '$lib/knowledge.js';
export { slugify };

function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

export async function getDocument(slug) {
	const sql = db();
	const [direct] = await sql`SELECT * FROM documents WHERE slug = ${slug} LIMIT 1`;
	if (direct) return { document: direct, redirectedFrom: null };
	const [redirect] =
		await sql`SELECT d.*, r.alias_title FROM redirects r JOIN documents d ON d.id = r.document_id WHERE r.alias_slug = ${slug} LIMIT 1`;
	return redirect ? { document: redirect, redirectedFrom: redirect.alias_title } : null;
}

export async function saveDocument({
	title,
	content,
	editor = 'Editor-01',
	summary = '',
	originalSlug
}) {
	const sql = db();
	const slug = originalSlug || slugify(title);
	const [doc] = await sql`
		WITH upserted AS (
			INSERT INTO documents (slug, title, content, editor_handle)
			VALUES (${slug}, ${title}, ${content}, ${editor})
			ON CONFLICT (slug) DO UPDATE SET
				title = EXCLUDED.title,
				content = EXCLUDED.content,
				editor_handle = EXCLUDED.editor_handle,
				updated_at = NOW()
			RETURNING *
		), inserted_revision AS (
			INSERT INTO revisions (document_id, content, editor_handle, summary)
			SELECT id, ${content}, ${editor}, ${summary} FROM upserted
		)
		SELECT * FROM upserted
	`;
	return doc;
}

export async function recentChanges(limit = 12) {
	return db()`SELECT slug, title, editor_handle, updated_at FROM documents ORDER BY updated_at DESC LIMIT ${limit}`;
}

export async function renderWiki(content, draftDocuments = []) {
	const sql = db();
	const names = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) =>
		match[1].trim()
	);
	let known = new Set();
	if (names.length) {
		const slugs = names.map(slugify);
		// const rows = await sql`SELECT slug FROM documents WHERE slug IN ${sql(slugs)} UNION SELECT alias_slug AS slug FROM redirects WHERE alias_slug IN ${sql(slugs)}`;
		const rows = await sql`
      SELECT slug FROM documents WHERE slug = ANY(${slugs})
      UNION
      SELECT alias_slug AS slug FROM redirects WHERE alias_slug = ANY(${slugs})
    `;
		known = new Set(rows.map((row) => row.slug));
	}
	const footnotes = new Map();
	let source = content.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, note) => {
		footnotes.set(id, note);
		return '';
	});
	source = source.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
		const slug = slugify(target);
		const draft = !known.has(slug) && draftDocuments.find((doc) => doc.slug === slug);
		if (draft) return `[${label || target}](/drafts?open=${draft.id} "wikilink:draft")`;
		return `[${label || target}](/wiki/${encodeURIComponent(slug)} "wikilink:${known.has(slug) ? 'exists' : 'missing'}")`;
	});
	source = source.replace(
		/\[\^([^\]]+)\]/g,
		(_, id) => `@@WIKIFOOTNOTE:${slugify(id)}:${id.replace(/[^\p{L}\p{N}_.-]/gu, '')}@@`
	);
	const renderer = new marked.Renderer();
	let headingIndex = 0;
	renderer.heading = ({ tokens, depth }) =>
		`<h${depth} id="section-${++headingIndex}">${renderer.parser.parseInline(tokens)}</h${depth}>`;
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.link = ({ href, title, tokens }) => {
		const label = renderer.parser.parseInline(tokens);
		const state = title?.startsWith('wikilink:') ? title.slice(9) : null;
		const safeHref = /^(?:https?:|mailto:|\/|#)/i.test(href) ? escapeHtml(href) : '#';
		return `<a href="${safeHref}"${state ? ` class="wiki-link ${state === 'missing' ? 'missing' : ''}"` : ''}>${label}</a>`;
	};
	let html = await marked.parse(source, { renderer, gfm: true });
	html = html.replace(
		/@@WIKIFOOTNOTE:([^:]+):([^@]+)@@/g,
		'<sup class="footnote-ref"><a href="#fn-$1">[$2]</a></sup>'
	);
	if (footnotes.size)
		html += `<section class="footnotes"><hr><ol>${[...footnotes].map(([id, note]) => `<li id="fn-${escapeHtml(slugify(id))}">${escapeHtml(note)}</li>`).join('')}</ol></section>`;
	return html;
}

export async function autoLinkDocument(content, suggestions = [], draftTitles = []) {
	const terms = [
		...new Set(suggestions.map((term) => term.trim()).filter((term) => term.length > 1))
	].slice(0, 20);
	const sql = db();
	const lowerTerms = terms.map((term) => term.toLowerCase());
	const rows = terms.length
		? await sql`SELECT title FROM documents WHERE LOWER(title) = ANY(${lowerTerms})`
		: [];
	return linkTerms(content, [...rows.map((row) => row.title), ...draftTitles]);
}

export function buildToc(content) {
	const counters = [0, 0, 0, 0, 0, 0];
	return [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match, index) => {
		const level = match[1].length;
		counters[level - 1] += 1;
		counters.fill(0, level);
		return {
			level,
			title: match[2].replace(/[*_`~]/g, ''),
			number: counters.slice(0, level).filter(Boolean).join('.'),
			id: `section-${index + 1}`
		};
	});
}
