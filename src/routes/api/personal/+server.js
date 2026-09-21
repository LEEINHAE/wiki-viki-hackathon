import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
export async function GET({ locals, url }) {
	if (!locals.user) return json({ message: '계정으로 로그인해 주세요.' }, { status: 401 });
	const id = url.searchParams.get('id');
	const sql = db();
	if (id) {
		if (!/^\d+$/.test(id)) return json({ message: '문서 번호를 확인해 주세요.' }, { status: 400 });
		const [state] =
			await sql`SELECT COALESCE(p.favorite,false) AS favorite,COALESCE(p.subscribed,false) AS subscribed FROM wv_visible_documents d LEFT JOIN wv_user_documents p ON p.document_id=d.id AND p.user_id=${locals.user.id} WHERE d.id=${id}::bigint AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL`;
		return state ? json(state) : json({ message: '문서를 찾을 수 없습니다.' }, { status: 404 });
	}
	const [favorites, recent, subscriptions] = await Promise.all([
		sql`SELECT d.id,d.slug,d.title,d.field FROM wv_user_documents p JOIN wv_visible_documents d ON d.id=p.document_id WHERE p.user_id=${locals.user.id} AND p.favorite AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL ORDER BY p.id DESC LIMIT 100`,
		sql`SELECT d.id,d.slug,d.title,d.field,p.viewed_at FROM wv_user_documents p JOIN wv_visible_documents d ON d.id=p.document_id WHERE p.user_id=${locals.user.id} AND p.viewed_at>NOW()-interval '30 days' AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL ORDER BY p.viewed_at DESC LIMIT 30`,
		sql`SELECT d.id,d.slug,d.title,d.field FROM wv_user_documents p JOIN wv_visible_documents d ON d.id=p.document_id WHERE p.user_id=${locals.user.id} AND p.subscribed AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL ORDER BY p.id DESC LIMIT 100`
	]);
	return json({ favorites, recent, subscriptions });
}
export async function POST({ locals, request }) {
	if (!locals.user) return json({ message: '계정으로 로그인해 주세요.' }, { status: 401 });
	try {
		const raw = await request.text();
		if (raw.length > 2000) return json({ message: '요청이 너무 큽니다.' }, { status: 400 });
		const values = JSON.parse(raw),
			sql = db();
		if (values.action === 'clear') {
			await sql.transaction([
				sql`DELETE FROM wv_user_documents WHERE user_id=${locals.user.id}`,
				sql`DELETE FROM wv_notifications WHERE user_id=${locals.user.id}`
			]);
		} else {
			if (
				!/^\d+$/.test(String(values.documentId)) ||
				!['visit', 'favorite', 'subscribe'].includes(values.action)
			)
				return json({ message: '저장할 항목을 확인해 주세요.' }, { status: 400 });
			await sql`SELECT wv_personal_document_v1(${String(values.documentId)}::bigint,${values.action},${values.value === true})`;
		}
		return json({ ok: true });
	} catch (cause) {
		return json(
			{
				message:
					cause.message === 'favorite_limit'
						? '즐겨찾기는 100개까지 저장할 수 있습니다.'
						: cause.message === 'subscription_limit'
							? '구독은 100개까지 저장할 수 있습니다.'
							: '저장하지 못했습니다. 문서 권한과 로그인 상태를 확인해 주세요.'
			},
			{ status: 409 }
		);
	}
}
