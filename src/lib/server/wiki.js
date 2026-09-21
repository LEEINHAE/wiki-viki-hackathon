import { db } from './db.js';
import { readLinkSnapshot } from './document-links.js';
import { linkedWikiTokens } from '../wiki-links.js';
import { marked } from 'marked';
import { createHeadingSequence } from '../wiki-headings.js';
export { buildToc } from '../wiki-headings.js';

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
	if (direct) return direct.deleted_at ? null : { document: direct, redirectedFrom: null };
	const [redirect] =
		await sql`SELECT d.*, r.alias_title FROM redirects r JOIN documents d ON d.id = r.document_id WHERE r.alias_slug = ${slug} AND d.deleted_at IS NULL LIMIT 1`;
	return redirect ? { document: redirect, redirectedFrom: redirect.alias_title } : null;
}

export { saveDocument } from './document-write.js';

export async function recentChanges(limit = 12) {
	return db()`SELECT slug, title, editor_handle, updated_at FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${limit}`;
}

export async function renderWiki(
	content,
	draftDocuments = [],
	linkChanges = {},
	{ anchorPrefix = '', imageLinks = false, sourceSlug = '', catalog = null } = {}
) {
	const links = linkedWikiTokens(content, catalog || (await readLinkSnapshot()).catalog, {
		sourceSlug,
		drafts: draftDocuments,
		linkChanges
	});
	const { tokens, footnotes } = links;
	const renderer = new marked.Renderer();
	const notes = new Map(),
		normalizedNotes = new Map();
	const reservedIds = new Set([...footnotes.keys()].map((id) => 'fn-' + slugify(id)));
	const usedIds = new Set();
	const noteLabel = (id) => id.replace(/[^\p{L}\p{N}_.-]/gu, '') || id;
	for (const [id, text] of footnotes) {
		const slug = slugify(id),
			base = 'fn-' + slug;
		let anchor = base,
			suffix = 2;
		while (usedIds.has(anchor) || (anchor !== base && reservedIds.has(anchor)))
			anchor = `${base}--${suffix++}`;
		usedIds.add(anchor);
		const note = { anchor, label: noteLabel(id), text, references: [] };
		notes.set(id, note);
		const matches = normalizedNotes.get(slug) || [];
		matches.push(note);
		normalizedNotes.set(slug, matches);
	}
	const renderText = renderer.text.bind(renderer);
	renderer.text = (token) => {
		if (token.footnoteId === undefined) return renderText(token);
		const matches = normalizedNotes.get(slugify(token.footnoteId));
		const note = notes.get(token.footnoteId) || (matches?.length === 1 ? matches[0] : null);
		if (!note) return renderText(token);
		const id = `${anchorPrefix}fnref-${note.anchor.slice(3)}-${note.references.length + 1}`;
		note.references.push(id);
		const label = escapeHtml(noteLabel(token.footnoteId));
		return `<sup class="footnote-ref"><a id="${escapeHtml(id)}" href="#${escapeHtml(anchorPrefix + note.anchor)}" aria-label="각주 ${label} 보기">[${label}]</a></sup>`;
	};
	const nextHeading = createHeadingSequence();
	renderer.heading = ({ tokens, depth }) => {
		const { id: headingId, number } = nextHeading(depth);
		const id = escapeHtml(anchorPrefix + headingId);
		return `<h${depth} id="${id}"><a class="section-number" href="#${id}" aria-label="${number}번 문단 링크">${number}.</a> ${renderer.parser.parseInline(tokens)}</h${depth}>`;
	};
	const renderTable = renderer.table.bind(renderer);
	let tableIndex = 0;
	renderer.table = (token) => {
		const number = ++tableIndex;
		const id = escapeHtml(`${anchorPrefix}table-${number}`);
		return `<div class="wiki-table"><p class="wiki-table-hint" id="${id}-hint">표가 잘리면 좌우로 스크롤하세요. 키보드: 표에 초점을 두고 ← →.</p><div class="wiki-table-scroll" id="${id}" tabindex="0" role="region" aria-label="표 ${number}" aria-describedby="${id}-hint">${renderTable(token)}</div></div>`;
	};
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.link = ({ href, title, tokens }) => {
		const label = renderer.parser.parseInline(tokens);
		const state = title?.startsWith('wikilink:') ? title.slice(9) : null;
		const safeHref = /^(?:https?:|mailto:|\/|#)/i.test(href)
			? escapeHtml(href.startsWith('#') ? '#' + anchorPrefix + href.slice(1) : href)
			: '#';
		return `<a href="${safeHref}"${state ? ` class="wiki-link ${state === 'missing' ? 'missing' : ''}"` : ''}${state === 'auto' ? ' data-auto-link="true" title="자동 연결"' : ''}>${label}</a>`;
	};
	if (imageLinks)
		renderer.image = ({ href, text }) => {
			const safeHref = /^(?:https?:|\/)/i.test(href) ? escapeHtml(href) : '#';
			return `<a href="${safeHref}">이미지: ${escapeHtml(text || '보기')}</a>`;
		};
	let html = await marked.parser(tokens, { renderer, gfm: true });
	if (notes.size)
		html += `<section class="footnotes" aria-label="각주"><hr><ol>${[...notes.values()]
			.map((note) => {
				const backlinks = note.references
					.map(
						(id, index) =>
							`<a class="footnote-backlink" href="#${escapeHtml(id)}" aria-label="각주 ${escapeHtml(note.label)}의 ${index + 1}번째 참조로 돌아가기">${note.references.length === 1 ? '본문으로' : `참조 ${index + 1}로`} ↩</a>`
					)
					.join('');
				return `<li id="${escapeHtml(anchorPrefix + note.anchor)}" tabindex="-1"><span class="footnote-label">[${escapeHtml(note.label)}]</span> ${escapeHtml(note.text)}${backlinks ? `<span class="footnote-backlinks">${backlinks}</span>` : ''}</li>`;
			})
			.join('')}</ol></section>`;
	return html;
}

export async function autoLinkDocument(content, suggestions = [], draftTitles = []) {
	const terms = [
		...new Set(suggestions.map((term) => term.trim()).filter((term) => term.length > 1))
	].slice(0, 20);
	const sql = db();
	const lowerTerms = terms.map((term) => term.toLowerCase());
	const rows = terms.length
		? await sql`SELECT title FROM documents WHERE deleted_at IS NULL AND LOWER(title) = ANY(${lowerTerms})`
		: [];
	return linkTerms(content, [...rows.map((row) => row.title), ...draftTitles]);
}
