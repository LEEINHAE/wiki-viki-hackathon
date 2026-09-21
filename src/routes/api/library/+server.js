import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
export async function POST({ request, url }) {
	if (request.headers.get('origin') !== url.origin)
		return json({ message: '같은 사이트에서 요청해 주세요.' }, { status: 403 });
	try {
		const text = await request.text();
		if (text.length > 4000) return json({ message: '문서 목록이 너무 큽니다.' }, { status: 400 });
		const { ids } = JSON.parse(text);
		if (!Array.isArray(ids) || ids.length > 130 || ids.some((id) => !/^\d{1,18}$/.test(String(id))))
			return json({ message: '문서 목록을 확인해 주세요.' }, { status: 400 });
		const rows = ids.length
			? await db()`SELECT id,slug,title,field,updated_at FROM wv_visible_documents WHERE id=ANY(${ids}::bigint[]) AND deleted_at IS NULL`
			: [];
		return json(rows, { headers: { 'cache-control': 'no-store' } });
	} catch {
		return json(
			{ message: '개인 목록의 문서 상태를 확인하지 못했습니다. 다시 시도해 주세요.' },
			{ status: 503 }
		);
	}
}
