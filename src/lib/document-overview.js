import { marked } from 'marked';

const isOverview = (heading) => /^(?:\d+[.\s]*)?(?:개요|overview)$/i.test(String(heading).trim());
function firstParagraph(text) {
	const paragraph = marked.lexer(String(text || '')).find((token) => token.type === 'paragraph');
	return paragraph?.text?.trim() || '';
}

export function ensureDocumentOverview(document) {
	const sections = [...(document.sections || [])];
	const index = sections.findIndex(
		(section) => isOverview(section.heading) && section.content?.trim()
	);
	if (index >= 0) {
		const [overview] = sections.splice(index, 1);
		return { ...document, sections: [{ ...overview, heading: '개요' }, ...sections] };
	}
	const overview =
		document.description?.trim() ||
		sections.map((section) => firstParagraph(section.content)).find(Boolean);
	return overview
		? { ...document, sections: [{ heading: '개요', content: overview }, ...sections] }
		: document;
}

export function ensureMarkdownOverview(content) {
	const tokens = marked.lexer(content);
	const index = tokens.findIndex((token) => token.type === 'heading' && isOverview(token.text));
	if (index >= 0) return content;
	const overview = firstParagraph(content);
	return overview ? `## 개요\n\n${overview}\n\n${content}` : content;
}
