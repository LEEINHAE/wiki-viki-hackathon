import { json } from '@sveltejs/kit';
import { searchOptions } from '$lib/search.js';
import { searchDocuments } from '$lib/server/search.js';
export async function GET({ url, locals }) {
	const options = searchOptions(url.searchParams);
	if (!options.q) return json([]);
	try {
		if (locals.autocompleteFailed) throw Error('Search unavailable');
		const { results } =
			locals.autocompleteResult ??
			(await searchDocuments({ ...options, page: 1, limit: 5, compact: true }));
		return json(
			results.map(({ id, slug, title, description, field }) => ({
				id,
				slug,
				title,
				description,
				field,
				isDraft: false
			})),
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch {
		return json(
			{ message: '검색을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' },
			{ status: 503 }
		);
	}
}
