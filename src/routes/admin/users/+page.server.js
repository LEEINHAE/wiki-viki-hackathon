import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { hashPassword } from '$lib/server/passwords.js';
import { roles } from '$lib/auth-policy.js';
import { validHandle } from '$lib/content-policy.js';
export async function load({ locals }) {
	if (!locals.user || locals.user.role !== 'admin') return { users: [], events: [] };
	const [users, events] = await Promise.all([
		db()`SELECT id,handle,role,active,created_at,updated_at::text AS version FROM wv_users ORDER BY handle LIMIT 200`,
		db()`SELECT e.action,e.details,e.created_at,a.handle AS actor,u.handle AS subject FROM wv_account_events e LEFT JOIN wv_users a ON a.id=e.actor_id JOIN wv_users u ON u.id=e.subject_id ORDER BY e.created_at DESC LIMIT 30`
	]);
	return { users, events };
}
export const actions = {
	create: async ({ request, locals }) => {
		if (locals.user?.role !== 'admin')
			return fail(403, { message: '운영 계정으로 로그인해 주세요.' });
		const form = await request.formData(),
			handle = String(form.get('handle') || '').trim(),
			role = String(form.get('role') || '');
		if (!validHandle(handle) || !roles.includes(role))
			return fail(400, { message: '계정 이름과 역할을 확인해 주세요.' });
		try {
			const hash = await hashPassword(String(form.get('password') || ''));
			await db()`WITH added AS(INSERT INTO wv_users(handle,role,password_hash) VALUES(${handle},${role},${hash}) RETURNING id) INSERT INTO wv_account_events(actor_id,subject_id,action,details) SELECT ${locals.user.id},id,'created',jsonb_build_object('role',${role}::text) FROM added`;
		} catch (cause) {
			return fail(cause.code === '23505' ? 409 : 400, {
				message:
					cause.code === '23505'
						? '이미 사용 중인 계정 이름입니다.'
						: '계정을 만들지 못했습니다. 비밀번호는 12~128자로 입력해 주세요.'
			});
		}
		redirect(303, '/admin/users');
	},
	access: async ({ request, locals }) => {
		if (locals.user?.role !== 'admin')
			return fail(403, { message: '운영 계정으로 로그인해 주세요.' });
		const form = await request.formData();
		try {
			await db()`SELECT wv_change_user_v1(${locals.user.id},${String(form.get('id'))}::bigint,${String(form.get('role'))},${form.get('active') === 'yes'})`;
		} catch (cause) {
			return fail(409, {
				message:
					cause.message === 'last_admin'
						? '마지막 운영 계정은 해제할 수 없습니다.'
						: '권한을 변경하지 못했습니다. 계정 상태를 다시 확인해 주세요.'
			});
		}
		redirect(303, '/admin/users');
	}
};
