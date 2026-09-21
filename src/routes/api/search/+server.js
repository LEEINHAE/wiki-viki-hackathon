import { json } from '@sveltejs/kit';
import { getCatalog } from '$lib/server/catalog.js';
import { searchCatalog } from '$lib/wiki-utils.js';

export async function GET({ url }) {
	const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
	if (!q) return json([]);
	try {
		const catalog = await getCatalog({ drafts: true });
		return json(
			searchCatalog([...catalog.documents, ...catalog.drafts], q)
				.slice(0, 5)
				.map(({ id, slug, title, description, field, isDraft }) => ({
					id,
					slug,
					title,
					description,
					field,
					isDraft
				}))
		);
	} catch {
		return json(
			{ message: '검색을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' },
			{ status: 503 }
		);
	}
}
