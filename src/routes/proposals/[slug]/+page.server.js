import { error, fail, redirect } from '@sveltejs/kit';
import { diffLines } from 'diff';
import { getDocument, renderWiki } from '$lib/server/wiki.js';
import { db } from '$lib/server/db.js';
import { inspectDocumentChange } from '$lib/server/review-inspection.js';
import { writeFailure } from '$lib/server/persistence.js';
import { permits } from '$lib/auth-policy.js';
export async function load({ params, url, locals }) {
	if (!locals.user) redirect(303, '/login');
	const result = await getDocument(params.slug, { followMerges: false });
	if (!result) error(404, '문서를 찾을 수 없습니다.');
	const d = result.document,
		sql = db(),
		page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
	const rows =
		await sql`SELECT p.id,p.status,p.summary,p.created_at,u.handle AS proposer,count(*) OVER() AS total FROM wv_visible_proposals p JOIN wv_users u ON u.id=p.proposer_id WHERE p.document_id=${d.id} ORDER BY p.created_at DESC,p.id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
	const selectedId = url.searchParams.get('open'),
		threadId = url.searchParams.get('thread');
	const [selected] = /^\d+$/.test(selectedId || '')
		? await sql`SELECT p.*,p.updated_at::text AS version,r.content AS base_content,u.handle AS proposer FROM wv_visible_proposals p JOIN wv_visible_revisions r ON r.id=p.base_revision_id AND r.document_id=p.document_id JOIN wv_users u ON u.id=p.proposer_id WHERE p.id=${selectedId}::bigint AND p.document_id=${d.id}`
		: [];
	const [thread] = /^\d+$/.test(threadId || '')
		? await sql`SELECT id,thread_title FROM wv_visible_discussions WHERE id=${threadId}::bigint AND document_id=${d.id}`
		: [];
	return {
		document: d,
		rows,
		page,
		total: Number(rows[0]?.total || 0),
		selected: selected || null,
		thread: thread || null,
		changes: selected ? diffLines(selected.base_content, selected.content) : [],
		html: selected ? await renderWiki(selected.content) : '',
		canReview: permits(locals.user.role, 'reviewer')
	};
}
export const actions = {
	create: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { message: '로그인이 필요합니다.' });
		const values = Object.fromEntries(await request.formData());
		const content = String(values.content || ''),
			summary = String(values.summary || '').trim();
		if (!content.trim() || content.length > 200000 || !summary || summary.length > 2000)
			return fail(400, {
				...values,
				creating: true,
				message: '본문과 변경 이유를 입력해 주세요. 본문은 20만 자, 이유는 2천 자까지입니다.'
			});
		let id;
		try {
			const result = await getDocument(params.slug, { followMerges: false });
			if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
			const inspection = await inspectDocumentChange(result.document, content, summary);
			if (!inspection.passed)
				return fail(400, {
					...values,
					creating: true,
					message: '콘텐츠 검사에 실패했습니다. 본문과 변경 이유를 수정해 주세요.'
				});
			const [row] =
				await db()`SELECT wv_create_proposal_v1(${JSON.stringify({ documentId: result.document.id, version: values.version, discussionId: values.discussionId || '', content, summary, inspection })}::jsonb) AS id`;
			id = row.id;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, { ...values, creating: true, ...failure });
		}
		redirect(303, `/proposals/${encodeURIComponent(params.slug)}?open=${id}`);
	},
	decide: async ({ request, params, locals }) => {
		if (!permits(locals.user?.role, 'reviewer'))
			return fail(403, { message: '검토 권한이 필요합니다.' });
		const values = Object.fromEntries(await request.formData());
		const content = String(values.content || ''),
			note = String(values.note || '');
		if (
			!['accepted', 'rejected'].includes(String(values.decision)) ||
			note.length > 2000 ||
			content.length > 200000 ||
			(values.decision === 'accepted' && (!content.trim() || values.reviewed !== 'yes'))
		)
			return fail(400, { ...values, message: '최종 본문과 검토 확인, 결정 사유를 확인해 주세요.' });
		try {
			const result = await getDocument(params.slug, { followMerges: false });
			if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
			const [proposal] =
				await db()`SELECT id FROM wv_visible_proposals WHERE id=${String(values.id)}::bigint AND document_id=${result.document.id}`;
			if (!proposal) return fail(404, { message: '제안을 찾을 수 없습니다.' });
			const inspection = await inspectDocumentChange(
				result.document,
				values.decision === 'accepted' ? content : result.document.content,
				note
			);
			if (!inspection.passed)
				return fail(400, {
					...values,
					message: '콘텐츠 검사에 실패했습니다. 최종 본문과 사유를 확인해 주세요.'
				});
			await db()`SELECT wv_decide_proposal_v1(${JSON.stringify({ ...values, editor: locals.user.handle, content, note, inspection })}::jsonb)`;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, { ...values, ...failure });
		}
		redirect(303, `/proposals/${encodeURIComponent(params.slug)}?open=${values.id}`);
	}
};
