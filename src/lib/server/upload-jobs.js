import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { getRequestEvent } from '$app/server';
export function uploadOwner(cookies, { create = false, secure = false } = {}) {
	const user = getRequestEvent().locals.user;
	if (user) return createHash('sha256').update(`account:${user.id}`).digest('hex');
	let value = cookies.get('wv_upload_owner');
	if (!/^[a-f0-9-]{36}$/.test(value || '')) {
		if (!create) return null;
		value = randomUUID();
		cookies.set('wv_upload_owner', value, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure,
			maxAge: 30 * 24 * 60 * 60
		});
	}
	return createHash('sha256').update(value).digest('hex');
}
export async function beginUpload({ owner, requestKey, hash, name, size, mode, retry = false }) {
	const sql = db();
	const attempt = randomUUID();
	const [inserted] =
		await sql`INSERT INTO wv_upload_jobs(owner_hash,request_key,file_hash,file_name,file_size,mode,attempt) VALUES(${owner},${requestKey},${hash},${name},${size},${mode},${attempt}) ON CONFLICT DO NOTHING RETURNING *`;
	if (inserted) return { job: inserted, run: true };
	const [existing] =
		await sql`SELECT *, (updated_at<NOW()-interval '6 minutes') AS expired FROM wv_upload_jobs WHERE owner_hash=${owner} AND (request_key=${requestKey} OR (file_hash=${hash} AND mode=${mode})) ORDER BY id LIMIT 1`;
	if (!existing || existing.file_hash !== hash || existing.mode !== mode)
		throw Error('request_key_conflict');
	if (
		retry &&
		(existing.state === 'failed' ||
			existing.state === 'interrupted' ||
			(existing.expired && existing.state !== 'completed'))
	) {
		const [claimed] =
			await sql`UPDATE wv_upload_jobs SET state='received',stage='재시도 파일 수신 완료',message='',attempt=${attempt},attempts=attempts+1,updated_at=clock_timestamp() WHERE id=${existing.id} AND attempt=${existing.attempt} AND state<>'completed' RETURNING *`;
		if (claimed) return { job: claimed, run: true };
	}
	return { job: existing, run: false };
}
export async function updateUpload(job, state, stage, message = '') {
	const rows =
		await db()`UPDATE wv_upload_jobs SET state=${state},stage=${stage},message=${message},updated_at=clock_timestamp() WHERE id=${job.id} AND attempt=${job.attempt} AND state NOT IN('completed','failed','interrupted') RETURNING id`;
	if (!rows.length) throw Error('job_changed');
}
export async function storeUploadSources(job, segments) {
	const sql = db();
	const payload = segments.map((s, i) => ({ ...s, ordinal: i + 1 }));
	await sql`SELECT wv_store_upload_sources_v1(${job.id},${job.attempt},${JSON.stringify(payload)}::jsonb)`;
}
export async function getUploadJobs(owner) {
	if (!owner) return [];
	return db()`SELECT id,file_name,file_size,mode,state,stage,message,created_at,updated_at,attempts,result,
    (state NOT IN('completed','failed','interrupted') AND updated_at<NOW()-interval '6 minutes') AS expired FROM wv_upload_jobs WHERE owner_hash=${owner} ORDER BY created_at DESC LIMIT 30`;
}
