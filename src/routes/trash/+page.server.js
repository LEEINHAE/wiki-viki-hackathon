import { actorHandle } from '$lib/server/auth.js';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { validHandle, inspectContent } from '$lib/server/governance.js';
import { semanticGovernance } from '$lib/server/openai.js';
import { writeFailure } from '$lib/server/persistence.js';

export async function load() {
	try {
		return {
			documents:
				await db()`SELECT id,slug,title,deleted_at,deleted_by,updated_at::text AS version FROM wv_visible_documents WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100`
		};
	} catch {
		return { documents: [], databaseError: '휴지통을 불러오지 못했습니다. 다시 시도해 주세요.' };
	}
}
export const actions = {
	restore: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		if (!validHandle(values.editor))
			return fail(400, { message: '익명 편집자 이름을 확인해 주세요.' });
		let restored;
		try {
			const [document] =
				await db()`SELECT * FROM wv_visible_documents WHERE id=${values.id} AND deleted_at IS NOT NULL`;
			if (!document) return fail(404, { message: '휴지통에 문서가 없습니다.' });
			const aliases =
				await db()`SELECT alias_title FROM redirects WHERE document_id=${document.id}`;
			const check = await inspectContent(
				[
					document.title,
					document.content,
					document.description,
					document.source_name,
					...aliases.map((a) => a.alias_title)
				],
				semanticGovernance
			);
			if (!check.passed)
				return fail(400, {
					message: '콘텐츠 검사에 실패해 복구할 수 없습니다. 운영 담당자에게 검토를 요청해 주세요.'
				});
			const [row] =
				await db()`SELECT wv_trash_document_v1(${document.id},${String(values.version || '')},${values.editor},true) AS document`;
			restored = row.document;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, `/wiki/${encodeURIComponent(restored.slug)}`);
	}
};
