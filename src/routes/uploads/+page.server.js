import { uploadOwner, getUploadJobs } from '$lib/server/upload-jobs.js';
import { db } from '$lib/server/db.js';
export async function load({ cookies, url }) {
	const owner = uploadOwner(cookies);
	const id = url.searchParams.get('open');
	try {
		const jobs = await getUploadJobs(owner);
		const [selected] =
			owner && /^\d+$/.test(id || '')
				? await db()`SELECT *, (state NOT IN('completed','failed','interrupted') AND updated_at<NOW()-interval '6 minutes') AS expired FROM wv_upload_jobs WHERE owner_hash=${owner} AND id=${id}::bigint`
				: [];
		const drafts = selected
			? await db()`SELECT id,title,status,governance->'mergedInto' AS merged,governance->>'publishedDocumentId' AS published_id FROM wv_visible_drafts WHERE wv_upload_job_id=${selected.id} ORDER BY id`
			: [];
		return {
			jobs,
			selected: selected
				? {
						id: selected.id,
						file_name: selected.file_name,
						state: selected.state,
						stage: selected.stage,
						message: selected.message,
						expired: selected.expired,
						attempts: selected.attempts
					}
				: null,
			drafts,
			problem: ''
		};
	} catch {
		return {
			jobs: [],
			selected: null,
			drafts: [],
			problem: '업로드 작업 목록을 불러오지 못했습니다. 새로고침해 주세요.'
		};
	}
}
