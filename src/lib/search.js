export function searchTerms(query = '') {
	const cleaned = query
		.normalize('NFKC')
		.toLowerCase()
		.trim()
		.slice(0, 200)
		.replace(/[?？!.,]/g, ' ')
		.replace(
			/(?:무엇인가요|무엇인지|뭔가요|알려주세요|알려줘|설명해주세요|설명해줘|궁금해요|어떻게|무엇|뭐야)/g,
			' '
		);
	return [
		...new Set(
			cleaned
				.split(/\s+/)
				.map((word) =>
					word.replace(/(?:이란|란|이랑|은|는|을|를|의|에서|에|와|과)$/u, '').replace(/[_-]/g, '')
				)
				.filter(Boolean)
		)
	].slice(0, 12);
}
export function searchOptions(params) {
	const q = (params.get('q') || '').trim().slice(0, 200);
	const number = (key, fallback, max) =>
		Math.min(max, Math.max(1, Number.parseInt(params.get(key), 10) || fallback));
	return {
		q,
		normalized: q
			.normalize('NFKC')
			.toLowerCase()
			.replace(/[\s_-]+/g, ''),
		terms: searchTerms(q),
		field: (params.get('field') || '').slice(0, 80),
		tag: (params.get('tag') || '').slice(0, 40),
		state: ['needs_review', 'reviewed', 'example', 'archived'].includes(params.get('state'))
			? params.get('state')
			: '',
		days: ['7', '30', '90', '365'].includes(params.get('days')) ? params.get('days') : '',
		sort: params.get('sort') === 'recent' ? 'recent' : 'relevance',
		page: number('page', 1, 10000),
		limit: number('limit', 20, 40)
	};
}
export const reviewLabels = {
	needs_review: '검토 필요',
	reviewed: '검토 완료',
	example: '예시 문서',
	archived: '보관됨'
};
