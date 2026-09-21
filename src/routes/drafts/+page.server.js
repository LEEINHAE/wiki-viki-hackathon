import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { regexGovernance, validHandle } from '$lib/server/governance.js';
import { semanticGovernance } from '$lib/server/openai.js';
import { saveDocument, slugify } from '$lib/server/wiki.js';

export async function load({ url }) {
	try {
		const sql = db(); const drafts = await sql`SELECT * FROM drafts WHERE status <> 'published' ORDER BY created_at DESC`;
		const requested = Number(url.searchParams.get('open')); return { drafts, selected: drafts.find((draft) => Number(draft.id) === requested) || null };
	} catch (error) { return { drafts: [], selected: null, databaseError: error.message }; }
}
export const actions = {
	update: async ({ request }) => {
		const form = await request.formData(); const id = Number(form.get('id')); const title = form.get('title')?.toString().trim(); const content = form.get('content')?.toString(); const editor = form.get('editor')?.toString();
		if (!title || !content || !validHandle(editor)) return fail(400, { message: '제목, 내용 및 올바른 익명 사용자 이름을 입력해 주세요.' });
		const regex = regexGovernance(content); const semantic = regex.passed ? await semanticGovernance(content) : { passed: false, reasons: [] }; const governance = { passed: regex.passed && semantic.passed, regex, semantic };
		await db()`UPDATE drafts SET title=${title},slug=${slugify(title)},content=${content},editor_handle=${editor},governance=${db().json(governance)},status=${governance.passed ? 'review' : 'blocked'},updated_at=NOW() WHERE id=${id} AND status <> 'published'`;
		redirect(303, `/drafts?open=${id}`);
	},
	publish: async ({ request }) => {
		const id = Number((await request.formData()).get('id')); const [draft] = await db()`SELECT * FROM drafts WHERE id=${id} AND status <> 'published'`;
		if (!draft) return fail(404, { message: '초안을 찾을 수 없습니다.' });
		const regex = regexGovernance(draft.content); const semantic = regex.passed ? await semanticGovernance(draft.content) : { passed: false, reasons: [] };
		if (!regex.passed || !semantic.passed) { await db()`UPDATE drafts SET status='blocked',governance=${db().json({ passed:false,regex,semantic })},updated_at=NOW() WHERE id=${id}`; return fail(400, { message: '콘텐츠 보호 검사로 게시가 차단되었습니다. 표시된 내용을 확인해 주세요.' }); }
		const document = await saveDocument({ title: draft.title, content: draft.content, editor: draft.editor_handle, summary: `초안 ${id}에서 게시`, originalSlug: draft.slug });
		const aliases = Array.isArray(draft.aliases) ? draft.aliases : [];
		for (const alias of aliases) await db()`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES (${slugify(alias)},${alias},${document.id}) ON CONFLICT (alias_slug) DO UPDATE SET document_id=EXCLUDED.document_id,alias_title=EXCLUDED.alias_title`;
		await db()`UPDATE drafts SET status='published',updated_at=NOW() WHERE id=${id}`; redirect(303, `/wiki/${document.slug}`);
	},
	delete: async ({ request }) => { const id = Number((await request.formData()).get('id')); await db()`DELETE FROM drafts WHERE id=${id} AND status <> 'published'`; redirect(303, '/drafts'); }
};
