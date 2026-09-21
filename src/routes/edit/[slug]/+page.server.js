import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, saveDocument, slugify } from '$lib/server/wiki.js';
import { validHandle, regexGovernance } from '$lib/server/governance.js';

export async function load({ params }) {
	try { const result = await getDocument(params.slug); const aliases = result ? await db()`SELECT alias_title FROM redirects WHERE document_id=${result.document.id} ORDER BY alias_title` : []; return { slug: params.slug, document: result?.document || null, aliases: aliases.map((row) => row.alias_title).join(', ') }; }
	catch (error) { return { slug: params.slug, document: null, databaseError: error.message }; }
}
export const actions = { save: async ({ request, params }) => {
	const form = await request.formData();
	const title = form.get('title')?.toString().trim();
	const content = form.get('content')?.toString() || '';
	const editor = form.get('editor')?.toString().trim();
	const summary = form.get('summary')?.toString().trim() || '';
	const aliases = form.get('aliases')?.toString() || '';
	if (!title || !content) return fail(400, { message: '제목과 내용을 모두 입력해 주세요.', title, content, editor, summary, aliases });
	if (!validHandle(editor)) return fail(400, { message: 'Editor-01 또는 Operator-A 형식의 익명 이름을 사용해 주세요.', title, content, editor, summary, aliases });
	const governance = regexGovernance(content);
	if (!governance.passed) return fail(400, { message: `콘텐츠 보호 검사로 저장이 차단되었습니다: ${governance.reasons.join(', ')}`, title, content, editor, summary, aliases });
	try { const document = await saveDocument({ title, content, editor, summary, originalSlug: params.slug });
		for (const alias of aliases.split(',').map((value) => value.trim()).filter(Boolean)) await db()`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES (${slugify(alias)},${alias},${document.id}) ON CONFLICT (alias_slug) DO UPDATE SET alias_title=EXCLUDED.alias_title,document_id=EXCLUDED.document_id`;
		redirect(303, `/wiki/${document.slug}`); }
	catch (error) { return fail(500, { message: error.message, title, content, editor, summary, aliases }); }
}, delete: async ({ params }) => {
	const result = await getDocument(params.slug); if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
	await db()`DELETE FROM documents WHERE id=${result.document.id}`; redirect(303, '/');
} };
