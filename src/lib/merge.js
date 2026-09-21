import { slugify } from './knowledge.js';

export function mergeCandidates(draft, documents) {
	const normalize = (value) => (typeof value === 'string' ? slugify(value.normalize('NFKC')) : '');
	const names = new Set(
		[draft.title, ...(Array.isArray(draft.aliases) ? draft.aliases : [])]
			.map(normalize)
			.filter(Boolean)
	);
	return documents.map((document) => ({
		...document,
		matched: [document.title, document.slug, ...(document.aliases || [])].some((name) =>
			names.has(normalize(name))
		)
	}));
}

export function validMergeResult(value) {
	const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === 3 &&
		text(value.content, 200000) &&
		text(value.summary, 2000) &&
		Array.isArray(value.conflicts) &&
		value.conflicts.length <= 30 &&
		value.conflicts.every(
			(item) =>
				item &&
				typeof item === 'object' &&
				!Array.isArray(item) &&
				Object.keys(item).length === 3 &&
				['topic', 'previous', 'incoming'].every((key) => text(item[key], 3000))
		)
	);
}
