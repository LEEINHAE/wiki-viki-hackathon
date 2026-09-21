import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument } from '$lib/server/wiki.js';
import { validHandle, regexGovernance } from '$lib/server/governance.js';

export async function load({ params }) {
	const result = await getDocument(params.slug); if (!result) error(404, '문서를 찾을 수 없습니다.');
	const threads = await db()`SELECT * FROM discussions WHERE document_id=${result.document.id} ORDER BY created_at DESC`;
	return { document: result.document, threads };
}
export const actions = { default: async ({ request, params }) => {
	const form = await request.formData(); const title = form.get('title')?.toString().trim(); const body = form.get('body')?.toString().trim(); const editor = form.get('editor')?.toString().trim();
	if (!title || !body || !validHandle(editor)) return fail(400, { message: '모든 항목을 입력하고 익명 사용자 이름을 사용해 주세요.', title, body, editor });
	const governance = regexGovernance(`${title}\n${body}`); if (!governance.passed) return fail(400, { message: `콘텐츠 보호 검사로 등록이 차단되었습니다: ${governance.reasons.join(', ')}`, title, body, editor });
	const result = await getDocument(params.slug); if (!result) return fail(404);
	await db()`INSERT INTO discussions (document_id,thread_title,body,editor_handle) VALUES (${result.document.id},${title},${body},${editor})`;
	return { success: true };
} };
