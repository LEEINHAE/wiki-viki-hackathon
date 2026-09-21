import { json } from '@sveltejs/kit';
import { uploadOwner, getUploadJobs } from '$lib/server/upload-jobs.js';
import { db } from '$lib/server/db.js';
export async function GET({ cookies, url }) {
	const owner = uploadOwner(cookies);
	if (!owner) return json([], { headers: { 'cache-control': 'no-store' } });
	try {
		const id = url.searchParams.get('job');
		const jobs =
			id && /^\d+$/.test(id)
				? await db()`SELECT id,file_name,mode,state,stage,message,updated_at,result,(state NOT IN('completed','failed','interrupted') AND updated_at<NOW()-interval '6 minutes') AS expired FROM wv_upload_jobs WHERE id=${id}::bigint AND owner_hash=${owner}`
				: await getUploadJobs(owner);
		return json(jobs, { headers: { 'cache-control': 'no-store' } });
	} catch {
		return json(
			{ message: '작업 상태를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.' },
			{ status: 503 }
		);
	}
}
