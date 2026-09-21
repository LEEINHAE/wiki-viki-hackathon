import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, buildToc } from '$lib/server/wiki.js';
import { actorHandle } from '$lib/server/auth.js';
import { validHandle, inspectContent } from '$lib/server/governance.js';
import { semanticGovernance } from '$lib/server/openai.js';
import { writeFailure } from '$lib/server/persistence.js';
import { permits } from '$lib/auth-policy.js';

export async function load({ params, url, locals }) {
	const result = await getDocument(params.slug, { followMerges: false });
	if (!result) error(404, '문서를 찾을 수 없습니다.');
	const sql = db(),
		d = result.document,
		page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
	const status = ['open', 'resolved'].includes(url.searchParams.get('status'))
		? url.searchParams.get('status')
		: '';
	const threads =
		await sql`SELECT t.*,updated_at::text AS version,count(*) OVER() AS total,(SELECT count(*) FROM wv_visible_replies WHERE discussion_id=t.id) AS replies FROM wv_visible_discussions t WHERE document_id=${d.id} AND (${status}='' OR status=${status}) ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
	const requested = url.searchParams.get('thread'),
		id = /^\d+$/.test(requested || '') ? requested : threads[0]?.id;
	const [selected] = id
		? await sql`SELECT *,updated_at::text AS version FROM wv_visible_discussions WHERE id=${id}::bigint AND document_id=${d.id}`
		: [];
	const replyPage = Math.max(
		1,
		Math.min(10000, Number.parseInt(url.searchParams.get('replies')) || 1)
	);
	const [replies, revisions] = await Promise.all([
		selected
			? sql`SELECT r.id,r.body,r.created_at,u.handle,count(*) OVER() AS total FROM wv_visible_replies r JOIN wv_users u ON u.id=r.actor_id WHERE discussion_id=${selected.id} ORDER BY r.created_at,r.id LIMIT 30 OFFSET ${(replyPage - 1) * 30}`
			: [],
		sql`SELECT id,summary FROM wv_visible_revisions WHERE document_id=${d.id} ORDER BY created_at DESC,id DESC LIMIT 20`
	]);
	return {
		document: d,
		threads,
		selected: selected || null,
		replies,
		revisions,
		page,
		status,
		total: Number(threads[0]?.total || 0),
		replyPage,
		replyTotal: Number(replies[0]?.total || 0),
		toc: buildToc(d.content),
		canResolve:
			!!locals.user &&
			(String(selected?.actor_id) === String(locals.user.id) ||
				permits(locals.user.role, 'reviewer'))
	};
}
export const actions = {
	default: async ({ request, params, locals }) => {
		const form = await request.formData(),
			values = Object.fromEntries(form);
		const intent = String(form.get('intent') || 'create'),
			body = String(form.get('body') || '').trim(),
			title = String(form.get('title') || '').trim(),
			editor = actorHandle(String(form.get('editor') || '').trim());
		const invalid = (status, message) => fail(status, { ...values, message });
		try {
			const result = await getDocument(params.slug, { followMerges: false });
			if (!result) return invalid(404, '문서를 찾을 수 없습니다.');
			const d = result.document;
			if (intent === 'reply' || intent === 'resolve') {
				if (!locals.user) return invalid(401, '답글과 해결 표시는 계정으로 로그인해 주세요.');
				const [thread] = /^\d+$/.test(String(values.threadId || ''))
					? await db()`SELECT id FROM wv_visible_discussions WHERE id=${String(values.threadId)}::bigint AND document_id=${d.id}`
					: [];
				if (!thread) return invalid(404, '토론을 찾을 수 없습니다.');
				if (intent === 'reply') {
					if (!body || body.length > 20000) return invalid(400, '답글을 1~2만 자로 입력해 주세요.');
					const inspection = await inspectContent([body], semanticGovernance);
					if (!inspection.passed)
						return invalid(400, '콘텐츠 검사로 답글이 차단되었습니다. 내용을 수정해 주세요.');
					await db()`SELECT wv_reply_v1(${JSON.stringify({ threadId: thread.id, body, inspection })}::jsonb)`;
				} else {
					if (
						!['open', 'resolved'].includes(String(values.status)) ||
						(values.revisionId && !/^\d+$/.test(String(values.revisionId)))
					)
						return invalid(400, '상태와 관련 리비전을 확인해 주세요.');
					await db()`SELECT wv_resolve_discussion_v1(${JSON.stringify({ id: thread.id, version: values.version, status: values.status, revisionId: values.revisionId || '' })}::jsonb)`;
				}
				return {
					success: true,
					message: intent === 'reply' ? '답글을 등록했습니다.' : '토론 상태를 변경했습니다.'
				};
			}
			if (
				intent !== 'create' ||
				!title ||
				!body ||
				title.length > 200 ||
				body.length > 20000 ||
				!validHandle(editor)
			)
				return invalid(400, '주제와 의견, 올바른 작업용 이름을 입력해 주세요.');
			const anchor = String(values.anchor || '');
			if (anchor && !buildToc(d.content).some((h) => h.id === anchor))
				return invalid(409, '대상 문단이 변경되었습니다. 최신 문서에서 다시 선택해 주세요.');
			const governance = await inspectContent([title, body], semanticGovernance);
			if (!governance.passed)
				return invalid(400, '콘텐츠 검사로 등록이 차단되었습니다. 제목과 의견을 수정해 주세요.');
			const rows =
				await db()`INSERT INTO discussions(document_id,thread_title,body,editor_handle,paragraph_anchor,target_revision_id)
   SELECT id,${title},${body},${editor},${anchor},(SELECT id FROM wv_visible_revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) FROM wv_visible_documents d WHERE id=${d.id} AND deleted_at IS NULL AND wv_archived_at IS NULL AND updated_at=${String(values.version || d.version)}::text::timestamptz RETURNING id`;
			if (!rows.length)
				return invalid(409, '문서가 변경되었습니다. 입력은 유지됩니다. 최신 내용을 확인해 주세요.');
			return { success: true, message: '토론을 등록했습니다.' };
		} catch (cause) {
			const failure = writeFailure(cause);
			return invalid(failure.status, failure.message);
		}
	}
};
