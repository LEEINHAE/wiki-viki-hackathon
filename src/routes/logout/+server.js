import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { tokenHash } from '$lib/server/passwords.js';
export async function POST({ cookies }) {
	const token = cookies.get('wv_session');
	if (token) await db()`DELETE FROM wv_sessions WHERE token_hash=${tokenHash(token)}`;
	cookies.delete('wv_session', { path: '/' });
	redirect(303, '/login');
}
