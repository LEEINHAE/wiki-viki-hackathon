import { fail, redirect } from '@sveltejs/kit';
import { signIn } from '$lib/server/auth.js';
import { localReturn } from '$lib/auth-policy.js';
import { validHandle } from '$lib/content-policy.js';
export function load({ locals, url }) {
	const accountLogin = url.searchParams.get('account') === '1';
	if ((locals.user || locals.demo) && !accountLogin)
		redirect(303, localReturn(url.searchParams.get('next')));
	const handle = url.searchParams.get('handle') || '';
	return {
		next: localReturn(url.searchParams.get('next')),
		handle: validHandle(handle) ? handle : ''
	};
}
export const actions = {
	default: async (event) => {
		const form = await event.request.formData();
		if (event.locals.demo && event.url.searchParams.get('account') !== '1')
			redirect(303, localReturn(form.get('next')));
		const handle = String(form.get('handle') || '').trim(),
			password = String(form.get('password') || '');
		if (!validHandle(handle) || password.length < 12 || password.length > 128)
			return fail(400, { message: '계정 이름 또는 비밀번호를 확인해 주세요.', handle });
		try {
			const problem = await signIn(event, handle, password);
			if (problem) return fail(problem.status, { message: problem.message, handle });
		} catch {
			return fail(503, { message: '로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.', handle });
		}
		redirect(303, localReturn(form.get('next')));
	}
};
