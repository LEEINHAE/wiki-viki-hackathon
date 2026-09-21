import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, renderWiki } from '$lib/server/wiki.js';
import { inspectDocumentChange } from '$lib/server/review-inspection.js';
import { writeFailure } from '$lib/server/persistence.js';
import { slugify } from '$lib/wiki-utils.js';

export async function load({ params, url }) {
	const source = (await getDocument(params.slug, { followMerges: false }))?.document;
	if (!source || source.wv_archived_at) error(404, '병합할 활성 문서를 찾을 수 없습니다.');
	const name = url.searchParams.get('target') || '';
	const target = name ? (await getDocument(slugify(name)))?.document : null;
	if (name && (!target || target.id === source.id || target.wv_archived_at))
		error(400, '서로 다른 활성 게시 문서를 선택해 주세요.');
	const [sourceHtml, targetHtml, tags] = await Promise.all([
		renderWiki(source.content),
		target ? renderWiki(target.content) : '',
		db()`SELECT DISTINCT tag FROM wv_document_tags WHERE document_id=ANY(${[source.id, ...(target ? [target.id] : [])]}::bigint[]) ORDER BY tag`
	]);
	return { source, target, sourceHtml, targetHtml, tags: tags.map((t) => t.tag), targetName: name };
}
export const actions = {
	default: async ({ params, request, locals }) => {
		const values = Object.fromEntries(await request.formData());
		const content = String(values.content || ''),
			note = String(values.note || '');
		const tags = [
			...new Set(
				String(values.tags || '')
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			)
		];
		if (
			!content.trim() ||
			content.length > 200000 ||
			note.length > 2000 ||
			tags.length > 20 ||
			tags.some((t) => t.length > 40) ||
			values.reviewed !== 'yes'
		)
			return fail(400, {
				...values,
				message: '최종 본문, 태그(20개·각 40자 이내), 병합 확인을 검토해 주세요.'
			});
		let saved;
		try {
			const source = (await getDocument(params.slug, { followMerges: false }))?.document;
			const target = (await getDocument(String(values.targetSlug || ''), { followMerges: false }))
				?.document;
			if (!source || !target) return fail(404, { ...values, message: '문서를 찾을 수 없습니다.' });
			const [sourceCheck, targetCheck] = await Promise.all([
				inspectDocumentChange(source, source.content, note),
				inspectDocumentChange(target, content, source.content, ...tags, note)
			]);
			if (!sourceCheck.passed || !targetCheck.passed)
				return fail(400, {
					...values,
					message: '콘텐츠 검사에 실패했습니다. 두 원문과 최종 본문을 확인해 주세요.'
				});
			const [row] =
				await db()`SELECT wv_merge_documents_v1(${JSON.stringify({ sourceId: source.id, targetId: target.id, sourceVersion: values.sourceVersion, targetVersion: values.targetVersion, content, tags, note, reviewed: values.reviewed, editor: locals.user.handle, inspection: targetCheck })}::jsonb) AS result`;
			saved = row.result;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, { ...values, ...failure });
		}
		redirect(303, `/wiki/${encodeURIComponent(saved.slug)}`);
	}
};
