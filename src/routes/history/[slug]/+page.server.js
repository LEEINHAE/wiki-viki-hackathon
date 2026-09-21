import { error, fail, redirect } from '@sveltejs/kit';
import { diffLines } from 'diff';
import { db } from '$lib/server/db.js';
import { getDocument, saveDocument } from '$lib/server/wiki.js';

export async function load({ params, url }) {
	const result = await getDocument(params.slug); if (!result) error(404, '문서를 찾을 수 없습니다.');
	const sql = db();
	const revisions = await sql`SELECT id,editor_handle,summary,created_at,content FROM revisions WHERE document_id=${result.document.id} ORDER BY created_at DESC`;
	const selected = Number(url.searchParams.get('diff'));
	let changes = [];
	if (selected) { const index = revisions.findIndex((item) => Number(item.id) === selected); const oldText = revisions[index + 1]?.content || ''; changes = diffLines(oldText, revisions[index]?.content || ''); }
	return { document: result.document, revisions, selected, changes };
}
export const actions = { rollback: async ({ request, params }) => {
	const id = Number((await request.formData()).get('revision'));
	const result = await getDocument(params.slug); if (!result) return fail(404);
	const [revision] = await db()`SELECT content FROM revisions WHERE id=${id} AND document_id=${result.document.id}`;
	if (!revision) return fail(404, { message: '리비전을 찾을 수 없습니다.' });
	await saveDocument({ title: result.document.title, content: revision.content, editor: 'Operator-A', summary: `리비전 ${id}(으)로 되돌림`, originalSlug: result.document.slug });
	redirect(303, `/wiki/${result.document.slug}`);
} };
