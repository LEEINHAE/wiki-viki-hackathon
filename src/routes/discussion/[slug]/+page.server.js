import { error, fail, isHttpError } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db.js';
import { getDocument } from '$lib/server/wiki.js';
import { validHandle } from '$lib/server/governance.js';
import { inspectDiscussionContent } from '$lib/server/document-governance.js';

export async function load({ params, request }) {
	const semanticAvailable = Boolean(env.OPENAI_API_KEY);
	const unavailable = { slug: params.slug, document: null, threads: null, semanticAvailable };
	try {
		const result = await getDocument(params.slug);
		if (!result) {
			if (request?.method === 'POST')
				return {
					...unavailable,
					databaseError: '문서를 찾을 수 없습니다. 작성한 내용을 복사해 보관해 주세요.'
				};
			error(404, '문서를 찾을 수 없습니다.');
		}
		const threads =
			await db()`SELECT * FROM discussions WHERE document_id=${result.document.id} ORDER BY created_at DESC`;
		return { slug: params.slug, document: result.document, threads, semanticAvailable };
	} catch (cause) {
		if (isHttpError(cause)) throw cause;
		return {
			...unavailable,
			databaseError: '토론을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.'
		};
	}
}

export const actions = {
	default: async ({ request, params }) => {
		const form = await request.formData();
		const values = Object.fromEntries(
			['title', 'body', 'editor'].map((key) => [key, form.get(key)?.toString() || ''])
		);
		const title = values.title.trim();
		const body = values.body.trim();
		const editor = values.editor.trim();
		if (!title || !body || !validHandle(editor))
			return fail(400, {
				message: '모든 항목을 입력하고 익명 사용자 이름을 사용해 주세요.',
				...values
			});
		try {
			const result = await getDocument(params.slug);
			if (!result)
				return fail(404, {
					message: '문서를 찾을 수 없어 등록하지 않았습니다. 작성한 내용을 유지했습니다.',
					...values
				});
			const governance = await inspectDiscussionContent({ title, body });
			if (!governance.passed)
				return fail(governance.semantic.unavailable ? 503 : 400, {
					message: governance.semantic.unavailable
						? 'AI 의미 검사를 완료하지 못해 등록하지 않았습니다. 작성한 내용을 유지했습니다. 잠시 후 다시 시도해 주세요.'
						: '콘텐츠 보호 검사로 등록이 차단되었습니다. 안내된 주제·의견을 수정해 주세요.',
					...values,
					governance
				});
			const sql = db();
			const saved = await sql.transaction(
				(tx) => [
					tx`SET LOCAL lock_timeout = '10s'`,
					tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`,
					tx`INSERT INTO discussions (document_id,thread_title,body,editor_handle)
					SELECT id,${title},${body},${editor} FROM documents
					WHERE id=${result.document.id} AND deleted_at IS NULL AND lifecycle_version=${result.document.lifecycle_version}
					RETURNING id`
				],
				{ isolationLevel: 'ReadCommitted' }
			);
			if (!saved.at(-1).length)
				return fail(409, {
					...values,
					message:
						'문서의 삭제·복구 상태가 변경되어 등록하지 않았습니다. 작성한 내용을 유지했습니다. 현재 문서를 확인해 주세요.'
				});
			return {
				success: true,
				semanticSkipped: governance.semantic.skipped,
				title: '',
				body: '',
				editor
			};
		} catch {
			return fail(500, {
				message:
					'등록 결과를 확인하지 못했습니다. 작성한 내용을 유지했습니다. 토론 목록을 확인한 뒤 다시 시도해 주세요.',
				...values
			});
		}
	}
};
