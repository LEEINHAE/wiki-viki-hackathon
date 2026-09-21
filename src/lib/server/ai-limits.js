import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { getRequestEvent } from '$app/server';
export async function acquireAIRequest(identity, scope) {
	const sql = db();
	const user = getRequestEvent().locals.user;
	if (user) identity = `user:${user.id}`;
	const identityHash = createHash('sha256').update(identity).digest('hex');
	const key = createHash('sha256')
		.update(identityHash + '\n' + scope)
		.digest('hex');
	const token = randomUUID();
	const [lease] =
		await sql`INSERT INTO wv_ai_requests(request_key,token,expires_at) VALUES(${key},${token},NOW()+interval '130 seconds') ON CONFLICT(request_key) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE wv_ai_requests.expires_at<NOW() RETURNING request_key`;
	if (!lease) return { error: 'duplicate' };
	const release = async () =>
		await sql`DELETE FROM wv_ai_requests WHERE request_key=${key} AND token=${token}`;
	const [allowed] =
		await sql`INSERT INTO wv_ai_limits(identity_hash,window_start,used) VALUES(${identityHash},to_timestamp(floor(extract(epoch FROM NOW())/600)*600),1)
    ON CONFLICT(identity_hash,window_start) DO UPDATE SET used=wv_ai_limits.used+1 WHERE wv_ai_limits.used<6 RETURNING used`;
	if (!allowed) {
		await release();
		return { error: 'rate_limit' };
	}
	await sql`DELETE FROM wv_ai_limits WHERE window_start<NOW()-interval '1 day'`;
	return { release };
}
