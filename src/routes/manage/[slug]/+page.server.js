import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument } from '$lib/server/wiki.js';
import { actorHandle } from '$lib/server/auth.js';
import { inspectContent } from '$lib/server/governance.js';
import { semanticGovernance } from '$lib/server/openai.js';
import { writeFailure } from '$lib/server/persistence.js';
import { slugify } from '$lib/wiki-utils.js';
export async function load({ params, locals }) {
	if (!locals.user) error(401, '검토 기록에는 로그인이 필요합니다.');
	const result = await getDocument(params.slug);
	if (!result) error(404, '문서를 찾을 수 없습니다.');
	const sql = db(),
		[owners, reviews] = await Promise.all([
			sql`SELECT id,handle FROM wv_users WHERE active AND role IN('editor','reviewer','admin') ORDER BY handle`,
			sql`SELECT r.id,r.revision_id,r.note,r.next_review_on::text AS next_review_on,r.created_at,u.handle FROM wv_visible_reviews r JOIN wv_users u ON u.id=r.reviewer_id WHERE document_id=${result.document.id} ORDER BY r.created_at DESC LIMIT 30`
		]);
	return { document: result.document, owners, reviews };
}
export const actions = {
	default: async ({ request, params, locals }) => {
		if (!locals.user) return fail(401, { message: '로그인이 필요합니다.' });
		const values = Object.fromEntries(await request.formData());
		if (!['review', 'ownership', 'archive', 'access', 'rename'].includes(String(values.action)))
			return fail(400, { message: '작업을 확인해 주세요.' });
		if (values.action === 'access' && locals.user.role !== 'admin')
			return fail(403, { message: '권한 변경에는 운영 역할이 필요합니다.' });
		if (
			String(values.note || '').length > 2000 ||
			(values.nextReviewOn && !/^\d{4}-\d{2}-\d{2}$/.test(String(values.nextReviewOn)))
		)
			return fail(400, { message: '검토 메모와 날짜를 확인해 주세요.' });
		try {
			const result = await getDocument(params.slug);
			if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
			const d = result.document;
			if (
				values.action === 'rename' &&
				(!String(values.title || '').trim() ||
					String(values.title).length > 200 ||
					!slugify(String(values.title)) ||
					values.reviewed !== 'yes')
			)
				return fail(400, { ...values, message: '새 제목과 이름 변경 확인을 입력해 주세요.' });
			if (values.version !== d.version)
				return fail(409, { message: '문서가 변경되었습니다. 최신 본문을 다시 검토해 주세요.' });
			const aliases = await db()`SELECT alias_title FROM redirects WHERE document_id=${d.id}`;
			const tags = await db()`SELECT tag FROM wv_document_tags WHERE document_id=${d.id}`;
			const inspection = await inspectContent(
				[
					d.title,
					d.content,
					d.description,
					d.source_name,
					...aliases.map((a) => a.alias_title),
					...tags.map((t) => t.tag),
					String(values.note || ''),
					String(values.title || '')
				],
				['review', 'rename'].includes(String(values.action)) ? semanticGovernance : null
			);
			if (!inspection.passed)
				return fail(400, {
					message: '콘텐츠 검사에 실패했습니다. 문서와 검토 메모를 확인해 주세요.'
				});
			if (values.action === 'rename')
				await db()`SELECT wv_rename_document_v1(${JSON.stringify({ ...values, title: String(values.title).trim(), titleSlug: slugify(String(values.title)), id: d.id, editor: actorHandle(''), inspection })}::jsonb)`;
			else
				await db()`SELECT wv_manage_document_v1(${JSON.stringify({ ...values, id: d.id, editor: actorHandle(''), inspection })}::jsonb)`;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, `/manage/${encodeURIComponent(params.slug)}`);
	}
};
