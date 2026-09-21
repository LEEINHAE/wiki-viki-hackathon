import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { checkPassword, hashPassword } from '$lib/server/passwords.js';
export async function load({ locals }) {
	if (!locals.user) redirect(303, '/login');
	const [row] =
		await db()`SELECT count(*)::int AS count FROM wv_sessions WHERE user_id=${locals.user.id} AND expires_at>NOW()`;
	return { sessions: row.count };
}
export const actions = {
	password: async ({ request, locals, cookies }) => {
		if (!locals.user) return fail(401, { message: '로그인이 필요합니다.' });
		const form = await request.formData();
		const [user] =
			await db()`SELECT password_hash FROM wv_users WHERE id=${locals.user.id} AND active`;
		if (!user || !(await checkPassword(String(form.get('current') || ''), user.password_hash)))
			return fail(400, { message: '현재 비밀번호를 확인해 주세요.' });
		if (form.get('password') !== form.get('confirm'))
			return fail(400, { message: '새 비밀번호 확인이 일치하지 않습니다.' });
		try {
			const hash = await hashPassword(String(form.get('password') || ''));
			await db()`SELECT wv_change_password_v1(${locals.user.id},${user.password_hash},${hash})`;
		} catch {
			return fail(400, { message: '비밀번호를 변경하지 못했습니다. 12~128자로 입력해 주세요.' });
		}
		cookies.delete('wv_session', { path: '/' });
		redirect(303, '/login');
	}
};
