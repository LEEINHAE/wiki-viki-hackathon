import { marked } from 'marked';

export function slugify(value) {
	return value
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/[^\p{L}\p{N}:.~-]/gu, '')
		.replace(/-+/g, '-')
		.toLowerCase();
}

const normalize = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = /[\p{L}\p{N}_]/u;
const particles =
	/^(?:은|는|이|가|을|를|의|와|과|도|만|에|에서|에서의|에게|에는|에도|으로|로|으로는|로는|부터|까지|부터는|까지는|보다|처럼|이며|이고|이다|입니다|이란|란|이라서)$/u;

export function createLinkCatalog(documents, aliases = []) {
	const active = documents.filter((document) => !document.deleted_at);
	const reserved = new Set(
		documents.filter((document) => document.deleted_at).map((document) => document.slug)
	);
	const byId = new Map(active.map((document) => [String(document.id), document]));
	const bySlug = new Map(active.map((document) => [document.slug, document.slug]));
	const direct = new Set(bySlug.keys());
	const candidates = new Map();
	function add(label, target) {
		if (typeof label !== 'string' || typeof target !== 'string') return;
		const term = normalize(label);
		// One-character and numeric-only names are too ambiguous for automatic prose links.
		if (term.length < 2 || !/\p{L}/u.test(term)) return;
		const entry = candidates.get(term) || { label: label.trim(), targets: new Set() };
		entry.targets.add(target);
		candidates.set(term, entry);
	}
	for (const document of active) add(document.title, document.slug);
	for (const alias of aliases) {
		const target = byId.get(String(alias.document_id));
		if (!target || reserved.has(alias.alias_slug)) continue;
		if (!direct.has(alias.alias_slug)) bySlug.set(alias.alias_slug, target.slug);
		// An old alias must never redirect prose to a different direct URL owner.
		add(alias.alias_title, bySlug.get(alias.alias_slug));
	}
	const terms = [...candidates.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
	const pattern = terms.length
		? new RegExp(terms.map((term) => escapePattern(term).replace(/ /g, '\\s+')).join('|'), 'giu')
		: null;
	return {
		bySlug,
		direct,
		ambiguous: [...candidates.values()]
			.filter((entry) => entry.targets.size > 1)
			.map((entry) => entry.label),
		matches(text) {
			if (!pattern) return [];
			const matches = [];
			for (const match of text.matchAll(pattern)) {
				const start = match.index,
					end = start + match[0].length;
				if (start && word.test(text[start - 1])) continue;
				const suffix = text.slice(end).match(/^[\p{L}\p{N}_]+/u)?.[0] || '';
				if (suffix && !particles.test(suffix)) continue;
				const entry = candidates.get(normalize(match[0]));
				if (entry?.targets.size !== 1) continue;
				matches.push({ start, end, label: match[0], target: [...entry.targets][0] });
			}
			return matches;
		}
	};
}

function visitTokens(tokens, visitor) {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (['link', 'image', 'code', 'codespan', 'html', 'escape'].includes(token.type)) {
			visitor(token, tokens, index);
			continue;
		}
		if (token.tokens) visitTokens(token.tokens, visitor);
		else visitor(token, tokens, index);
		if (token.items) visitTokens(token.items, visitor);
		if (token.type === 'table') {
			for (const cell of [...token.header, ...token.rows.flat()]) visitTokens(cell.tokens, visitor);
		}
	}
}

// The same parsed tokens drive rendered links, backlinks, the graph and the full inspection.
// No source text or document version is changed by automatic linking.
export function linkedWikiTokens(
	content,
	catalog,
	{ sourceSlug = '', drafts = [], linkChanges = {} } = {}
) {
	const known = new Set(catalog.bySlug.keys());
	for (const slug of linkChanges.removed || []) if (!catalog.direct.has(slug)) known.delete(slug);
	for (const slug of linkChanges.added || []) if (slug) known.add(slug);
	const footnotes = new Map();
	const explicitNames = new Map();
	let source = content.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, note) => {
		footnotes.set(id, note);
		return '';
	});
	source = source.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
		const slug = slugify(target);
		explicitNames.set(slug, target.trim());
		const draft = !known.has(slug) && drafts.find((document) => document.slug === slug);
		return draft
			? `[${label || target}](/drafts?open=${draft.id} "wikilink:draft")`
			: `[${label || target}](/wiki/${encodeURIComponent(slug)} "wikilink:${known.has(slug) ? 'exists' : 'missing'}")`;
	});
	const tokens = marked.lexer(source, { gfm: true });
	// Annotate real prose references before automatic linking. Opaque tokens
	// (code, links, images, HTML and escapes) retain their original text.
	visitTokens(tokens, (token) => {
		if (token.type !== 'text' || token.tokens || token.escaped) return;
		const parts = [];
		let cursor = 0;
		for (const match of token.text.matchAll(/\[\^([^\]]+)\]/g)) {
			if (match.index > cursor) {
				const text = token.text.slice(cursor, match.index);
				parts.push({ type: 'text', raw: text, text });
			}
			parts.push({ type: 'text', raw: match[0], text: match[0], footnoteId: match[1] });
			cursor = match.index + match[0].length;
		}
		if (!parts.length) return;
		if (cursor < token.text.length) {
			const text = token.text.slice(cursor);
			parts.push({ type: 'text', raw: text, text });
		}
		token.tokens = parts;
	});
	const connections = new Map(),
		missing = new Map(),
		used = new Set();
	if (sourceSlug) used.add(sourceSlug);
	visitTokens(tokens, (token) => {
		if (token.type !== 'link' || !token.href?.startsWith('/wiki/')) return;
		let slug;
		try {
			slug = decodeURIComponent(token.href.slice(6).split(/[?#]/)[0]);
		} catch {
			return;
		}
		const target = known.has(slug) && catalog.bySlug.get(slug);
		if (target) {
			used.add(target);
			if (target !== sourceSlug)
				connections.set(target, { target, automatic: false, label: token.text });
		} else if (token.title === 'wikilink:missing')
			missing.set(slug, { slug, title: explicitNames.get(slug) || token.text });
	});
	visitTokens(tokens, (token) => {
		if (token.type !== 'text' || token.tokens || token.escaped || token.footnoteId !== undefined)
			return;
		const parts = [],
			text = token.text;
		let cursor = 0;
		for (const match of catalog.matches(text)) {
			if (used.has(match.target) || !known.has(match.target)) continue;
			// Never link inside an escaped HTML entity.
			if (
				[...text.matchAll(/&(?:#\d+|#x[0-9a-f]+|\w+);/gi)].some(
					(range) => match.start < range.index + range[0].length && match.end > range.index
				)
			)
				continue;
			if (match.start > cursor)
				parts.push({
					type: 'text',
					raw: text.slice(cursor, match.start),
					text: text.slice(cursor, match.start)
				});
			parts.push({
				type: 'link',
				raw: match.label,
				text: match.label,
				href: `/wiki/${encodeURIComponent(match.target)}`,
				title: 'wikilink:auto',
				tokens: [{ type: 'text', raw: match.label, text: match.label }]
			});
			connections.set(match.target, { target: match.target, automatic: true, label: match.label });
			used.add(match.target);
			cursor = match.end;
		}
		if (!parts.length) return;
		if (cursor < text.length)
			parts.push({ type: 'text', raw: text.slice(cursor), text: text.slice(cursor) });
		token.tokens = parts;
	});
	return {
		tokens,
		footnotes,
		connections: [...connections.values()],
		missing: [...missing.values()]
	};
}
