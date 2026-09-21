import { marked } from 'marked';
import { plainText } from './knowledge.js';

// Share numbering between the rendered headings and their table of contents.
export function createHeadingSequence() {
	const counters = [0, 0, 0, 0, 0, 0];
	let index = 0;
	return (level) => {
		counters[level - 1] += 1;
		counters.fill(0, level);
		return {
			level,
			number: counters.slice(0, level).filter(Boolean).join('.'),
			id: `section-${++index}`
		};
	};
}

export function buildToc(content) {
	const nextHeading = createHeadingSequence();
	const items = [];
	marked.walkTokens(marked.lexer(content), (token) => {
		if (token.type === 'heading') {
			items.push({ ...nextHeading(token.depth), title: plainText(token.text) });
		}
	});
	return items;
}
