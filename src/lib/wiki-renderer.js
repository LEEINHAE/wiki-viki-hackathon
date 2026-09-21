import { marked } from 'marked';
import { slugify, plainText } from './wiki-utils.js';

export const escapeHtml = (value) =>
	String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
function safeUrl(value) {
	const clean = String(value).trim();
	return /^(https?:|mailto:|#[^\s]*$|\/(?![\\/]))/i.test(clean) &&
		!/[\u0000-\u001f\u007f]/.test(clean)
		? escapeHtml(clean)
		: '#';
}
export function buildToc(content) {
	const headings = [];
	const counts = [0, 0, 0, 0, 0, 0];
	const used = new Map();
	marked.walkTokens(marked.lexer(content), (token) => {
		if (token.type !== 'heading') return;
		const level = token.depth;
		counts[level - 1]++;
		counts.fill(0, level);
		const title = token.text.replace(/[*_`~]/g, '');
		const base = `heading-${slugify(title) || 'section'}`;
		const occurrence = (used.get(base) || 0) + 1;
		used.set(base, occurrence);
		headings.push({
			level,
			title,
			number: counts.slice(0, level).filter(Boolean).join('.'),
			id: base + (occurrence > 1 ? `-${occurrence}` : ''),
			legacyId: `section-${headings.length + 1}`
		});
	});
	return headings;
}
function outsideCode(content, transform) {
	return content
		.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`)/g)
		.map((part, index) => (index % 2 ? part : transform(part)))
		.join('');
}

export function headingSourceRange(content, id) {
	const toc = buildToc(content);
	let heading = 0,
		cursor = 0;
	for (const block of marked.lexer(content)) {
		const start = content.indexOf(block.raw, cursor);
		if (start < 0) continue;
		if (block.type === 'heading' && (toc[heading]?.id === id || toc[heading]?.legacyId === id))
			return { start, end: start + block.raw.trimEnd().length };
		marked.walkTokens([block], (token) => {
			if (token.type === 'heading') heading++;
		});
		cursor = start + block.raw.length;
	}
	return null;
}
export function renderWikiHtml(
	content,
	{ known = new Set(), pending = new Map(), onPassage } = {}
) {
	const notes = new Map();
	const references = new Map();
	let source = outsideCode(content, (part) =>
		part.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, note) => {
			notes.set(id, note);
			return '';
		})
	);
	source = outsideCode(source, (part) =>
		part.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
			const slug = slugify(target);
			const text = (label || target).replaceAll('[', '\\[').replaceAll(']', '\\]');
			if (/^https?:\/\//i.test(target))
				return `[${text}](${encodeURI(target).replaceAll(')', '%29')})`;
			if (!known.has(slug) && pending.has(slug))
				return `[${text}](/drafts?open=${Number(pending.get(slug))} "wikilink:draft")`;
			return `[${text}](/wiki/${encodeURIComponent(slug)} "wikilink:${known.has(slug) ? 'exists' : 'missing'}")`;
		})
	);
	source = outsideCode(source, (part) =>
		part.replace(/\[\^([^\]]+)\]/g, (_, id) => {
			const n = (references.get(id) || 0) + 1;
			references.set(id, n);
			return `WVFOOTNOTE${encodeURIComponent(id).replaceAll('%', 'Z')}X${n}ENDNOTE`;
		})
	);
	const toc = buildToc(source);
	let index = 0;
	let passage = 0;
	let section = '';
	const renderer = new marked.Renderer();
	renderer.heading = ({ tokens, depth }) => {
		const h = toc[index++];
		section = h.title;
		return `<span id="${h.legacyId}" class="legacy-anchor"></span><h${depth} id="${escapeHtml(h.id)}"><span class="section-number">${h.number}.</span> ${renderer.parser.parseInline(tokens)}</h${depth}>`;
	};
	renderer.paragraph = (token) => {
		const anchor = `paragraph-${++passage}`;
		onPassage?.({
			anchor,
			section,
			text: plainText(token.text).replace(/WVFOOTNOTE\S+?ENDNOTE/g, '')
		});
		return `<p id="${anchor}">${renderer.parser.parseInline(token.tokens)}</p>`;
	};
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.link = ({ href, title, tokens }) => {
		const state = ['wikilink:missing', 'wikilink:exists', 'wikilink:draft'].includes(title)
			? title.slice(9)
			: null;
		return `<a href="${safeUrl(href)}"${state ? ` class="wiki-link ${state === 'missing' ? 'missing' : ''}"` : ''}>${renderer.parser.parseInline(tokens)}</a>`;
	};
	renderer.image = ({ href, text }) =>
		`<img src="${safeUrl(href)}" alt="${escapeHtml(text)}" loading="lazy">`;
	renderer.table = function (token) {
		const anchor = `paragraph-${++passage}`;
		onPassage?.({
			anchor,
			section,
			text: [token.header, ...token.rows]
				.map((row) => row.map((cell) => plainText(cell.text)).join(' | '))
				.join('\n')
		});
		return `<div id="${anchor}" class="table-scroll" role="region" aria-label="표 · 가로로 스크롤할 수 있습니다" tabindex="0">${marked.Renderer.prototype.table.call(this, token)}</div>`;
	};
	let html = marked.parse(source, { renderer, gfm: true, async: false });
	for (const [id, count] of references) {
		for (let n = 1; n <= count; n++)
			html = html.replace(
				`WVFOOTNOTE${encodeURIComponent(id).replaceAll('%', 'Z')}X${n}ENDNOTE`,
				`<sup class="footnote-ref" id="fnref-${escapeHtml(slugify(id))}-${n}"><a href="#fn-${escapeHtml(slugify(id))}">[${escapeHtml(id)}]</a></sup>`
			);
	}
	if (notes.size)
		html += `<section class="footnotes" aria-label="각주"><hr><ol>${[...notes].map(([id, note]) => `<li id="fn-${escapeHtml(slugify(id))}">${escapeHtml(note)} ${Array.from({ length: references.get(id) || 0 }, (_, n) => `<a href="#fnref-${escapeHtml(slugify(id))}-${n + 1}" aria-label="각주 ${escapeHtml(id)} 본문으로 돌아가기">↩${n + 1}</a>`).join(' ')}</li>`).join('')}</ol></section>`;
	return html;
}
