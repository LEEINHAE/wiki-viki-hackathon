import { json } from '@sveltejs/kit';
import { suggestions } from '$lib/server/search.js';
export async function GET({ url }) {
	const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
	if (!q) return json({ results: [] });
	try {
		return json({ results: await suggestions(q) });
	} catch {
		return json({ message: '검색 제안을 불러올 수 없습니다.', results: [] }, { status: 503 });
	}
}
