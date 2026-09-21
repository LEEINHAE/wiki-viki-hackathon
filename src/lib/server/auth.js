import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { getRequestEvent } from '$app/server';
import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { tokenHash, checkPassword } from './passwords.js';

export function demoMode() {
	return dev && env.WIKI_DEMO_MODE === '1';
}
export async function sessionUser(cookies) {
	const token = cookies.get('wv_session');
	if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
	const [user] =
		await db()`SELECT u.id,u.handle,u.role FROM wv_sessions s JOIN wv_users u ON u.id=s.user_id WHERE s.token_hash=${tokenHash(token)} AND s.expires_at>NOW() AND u.active`;
	return user || null;
}
export async function sessionRead(cookies, prepareRead) {
	const token = cookies.get('wv_session');
	const validToken = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
	if (!validToken && !demoMode()) return { user: null, rows: [] };
	const sql = db();
	return sql.sessionRead(tokenHash(validToken ? token : ''), prepareRead(sql));
}
export function actorHandle(supplied) {
	const { locals } = getRequestEvent();
	return locals.user?.handle || (locals.demo ? supplied : '');
}
export async function signIn(event, handle, password) {
	const sql = db();
	// An IP bucket prevents account-name rotation from bypassing request limits;
	// the account bucket also bounds distributed guesses against one account.
	for (const identity of [`ip:${event.getClientAddress()}`, `handle:${handle}`]) {
		const [allowed] =
			await sql`INSERT INTO wv_login_limits(identity_hash,window_start,used) VALUES(${tokenHash(identity)},to_timestamp(floor(extract(epoch FROM NOW())/900)*900),1) ON CONFLICT(identity_hash,window_start) DO UPDATE SET used=wv_login_limits.used+1 WHERE wv_login_limits.used<10 RETURNING used`;
		if (!allowed)
			return { status: 429, message: '로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.' };
	}
	const [user] =
		await sql`SELECT id,handle,password_hash,active FROM wv_users WHERE handle=${handle}`;
	// Spend the same password-derivation work for absent accounts.
	const dummy = 'scrypt-v1$' + '0'.repeat(32) + '$' + '0'.repeat(128);
	const matches = await checkPassword(password, user?.password_hash || dummy);
	if (!user?.active || !matches)
		return { status: 400, message: '계정 이름 또는 비밀번호를 확인해 주세요.' };
	const token = randomBytes(32).toString('hex');
	const previous = event.cookies.get('wv_session');
	const results = await sql.transaction([
		sql`DELETE FROM wv_sessions WHERE expires_at<NOW() OR token_hash=${tokenHash(previous || '')}`,
		sql`DELETE FROM wv_login_limits WHERE window_start<NOW()-interval '1 day'`,
		sql`INSERT INTO wv_sessions(token_hash,user_id,expires_at) SELECT ${tokenHash(token)},id,NOW()+interval '12 hours' FROM wv_users WHERE id=${user.id} AND active AND password_hash=${user.password_hash} RETURNING id`
	]);
	if (!results.at(-1).length)
		return { status: 409, message: '계정 정보가 변경되었습니다. 다시 로그인해 주세요.' };
	event.cookies.set('wv_session', token, {
		path: '/',
		httpOnly: true,
		secure: env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: 43200
	});
	return null;
}
