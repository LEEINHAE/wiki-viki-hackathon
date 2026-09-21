import { redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { slugify } from '$lib/knowledge.js';

export async function load({ url }) {
	const title = (url.searchParams.get('title') || '').trim();
	if (!url.searchParams.has('title')) return { title };
	const slug = slugify(title);
	if (!title || title.length > 200 || !/[\p{L}\p{N}]/u.test(slug))
		return {
			title,
			invalidTitle: true,
			message: '문서 제목은 글자나 숫자를 포함해 1~200자로 입력해 주세요.'
		};
	try {
		const sql = db();
		const [existing] = await sql`
			SELECT id,title,slug,deleted_at FROM documents d
			WHERE d.title=${title} OR d.slug=${slug} OR EXISTS (
				SELECT 1 FROM redirects r WHERE r.document_id=d.id
				AND (r.alias_slug=${slug} OR r.alias_title=${title})
			)
			ORDER BY (d.slug=${slug}) DESC,d.id LIMIT 1`;
		if (existing) return { title, existing };
		const [pendingDraft] = await sql`
			SELECT id,title,status FROM drafts WHERE (slug=${slug} OR title=${title})
			AND status<>'published' ORDER BY updated_at DESC,id DESC LIMIT 1`;
		if (pendingDraft) return { title, pendingDraft };
	} catch {
		return {
			title,
			message:
				'기존 문서를 확인하지 못했습니다. 입력한 제목을 유지했으니 잠시 후 다시 시도해 주세요.'
		};
	}
	// The existing editor still rechecks conflicts and requires an explicit save.
	redirect(303, `/edit/${encodeURIComponent(slug)}?title=${encodeURIComponent(title)}`);
}
