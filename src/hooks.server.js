import { error, redirect, json } from '@sveltejs/kit';
import { sessionUser, demoMode } from '$lib/server/auth.js';
import { canAccessRoute } from '$lib/auth-policy.js';
import { searchOptions } from '$lib/search.js';
import { searchWithSession } from '$lib/server/search.js';
export async function handle({ event, resolve }) {
	const { request, url } = event;
	if (
		!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
		request.headers.get('origin') !== url.origin
	)
		return json({ message: '같은 사이트에서 요청해 주세요.' }, { status: 403 });
	event.locals.demo = demoMode();
	try {
		if (
			event.route.id === '/api/search' &&
			request.method === 'GET' &&
			url.searchParams.get('q')?.trim()
		) {
			try {
				const loaded = await searchWithSession(event.cookies, {
					...searchOptions(url.searchParams),
					page: 1,
					limit: 5,
					compact: true
				});
				event.locals.user = loaded.user;
				event.locals.autocompleteResult = loaded.result;
			} catch {
				// A search failure must not be reported as a failed login. Check the
				// session separately so the endpoint can show its normal retry state.
				event.locals.autocompleteFailed = true;
				event.locals.user = await sessionUser(event.cookies);
			}
		} else event.locals.user = await sessionUser(event.cookies);
	} catch (cause) {
		console.error('session_check_failed', cause.code || cause.name);
		error(503, '로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
	}
	if (event.route.id && !['/login', '/logout'].includes(event.route.id)) {
		if (!event.locals.user && !event.locals.demo) {
			if (url.pathname.startsWith('/api/') || request.method !== 'GET')
				return json(
					{ message: '로그인이 필요합니다.' },
					{ status: 401, headers: { 'cache-control': 'no-store' } }
				);
			redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
		}
		const action = [...url.searchParams.keys()].find((k) => k.startsWith('/'))?.slice(1) || '';
		if (
			event.locals.user &&
			!canAccessRoute(event.locals.user.role, event.route.id, request.method, action)
		)
			error(
				403,
				event.locals.user.role === 'admin'
					? '관리자 모드에서는 문서의 수정 제안·검토/관리 기능을 제공하지 않습니다.'
					: '이 작업을 수행할 권한이 없습니다. 운영 담당자에게 문의해 주세요.'
			);
	}
	const response = await resolve(event);
	if (event.route.id) {
		response.headers.set('cache-control', 'private, no-store');
		response.headers.set('x-content-type-options', 'nosniff');
		response.headers.set('referrer-policy', 'same-origin');
	}
	return response;
}
