import { fail, redirect, error } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { slugify } from '$lib/wiki-utils.js';
import { inspectContent } from '$lib/server/governance.js';
import { semanticGovernance } from '$lib/server/openai.js';
import { writeFailure } from '$lib/server/persistence.js';

export async function load({ locals, url }) {
	if (!locals.user) redirect(303, '/login');
	const sql = db(),
		userId = locals.user.id;
	const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
	const rows =
		await sql`SELECT c.id,c.title,c.description,c.shared,c.owner_id,u.handle AS owner,count(*) OVER() AS total FROM wv_collections c JOIN wv_users u ON u.id=c.owner_id WHERE c.owner_id=${userId} OR c.shared ORDER BY c.updated_at DESC,c.id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
	const id = url.searchParams.get('open');
	const [selected] = /^\d+$/.test(id || '')
		? await sql`SELECT c.*,c.updated_at::text AS version,u.handle AS owner FROM wv_collections c JOIN wv_users u ON u.id=c.owner_id WHERE c.id=${id}::bigint AND (c.owner_id=${userId} OR c.shared)`
		: [];
	if (id && !selected) error(404, '문서 묶음을 찾을 수 없습니다.');
	const items = selected
		? await sql`SELECT d.id,d.slug,d.title,d.description,i.position FROM wv_collection_items i JOIN wv_visible_documents d ON d.id=i.document_id AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL WHERE i.collection_id=${selected.id} ORDER BY i.position`
		: [];
	const own = selected?.owner_id === userId;
	const [count] = own
		? await sql`SELECT count(*)::integer AS n FROM wv_collection_items WHERE collection_id=${selected.id}`
		: [];
	return {
		rows,
		page,
		total: Number(rows[0]?.total || 0),
		selected: selected || null,
		items,
		own,
		unavailable: own ? count.n - items.length : 0
	};
}

export const actions = {
	save: async ({ locals, request, url }) => {
		if (!locals.user) return fail(401, { message: '로그인이 필요합니다.' });
		const values = Object.fromEntries(await request.formData());
		const title = String(values.title || '').trim(),
			description = String(values.description || '').trim();
		const names = String(values.documents || '')
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean);
		if (!title || title.length > 200 || description.length > 2000 || names.length > 100)
			return fail(400, {
				...values,
				message: '제목은 200자, 설명은 2천 자, 문서는 100개까지 입력해 주세요.'
			});
		let id;
		try {
			const inspection = await inspectContent([title, description, ...names], semanticGovernance);
			if (!inspection.passed)
				return fail(400, {
					...values,
					message: '콘텐츠 검사에 실패했습니다. 제목과 설명을 확인해 주세요.'
				});
			const slugs = names.map((name) => {
				if (name.startsWith('/wiki/') || /^https?:\/\//.test(name)) {
					const link = new URL(name, url.origin);
					if (link.origin !== url.origin || !link.pathname.startsWith('/wiki/')) return '';
					return decodeURIComponent(link.pathname.slice(6));
				}
				return slugify(name.replace(/^\[\[|\]\]$/g, ''));
			});
			const found = names.length
				? await db()`SELECT d.id,d.slug AS name FROM wv_visible_documents d WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND d.slug=ANY(${slugs}) UNION SELECT d.id,r.alias_slug AS name FROM redirects r JOIN wv_visible_documents d ON d.id=r.document_id WHERE d.deleted_at IS NULL AND d.wv_archived_at IS NULL AND r.alias_slug=ANY(${slugs})`
				: [];
			const index = new Map(found.map((d) => [d.name, d.id]));
			const missing = slugs.findIndex((slug) => !index.has(slug));
			if (missing !== -1)
				return fail(400, {
					...values,
					message: `${missing + 1}번째 문서를 찾을 수 없습니다. 현재 읽을 수 있는 게시 문서의 제목이나 주소를 입력해 주세요.`
				});
			const documentIds = [...new Set(slugs.map((slug) => index.get(slug)))];
			const [result] =
				await db()`SELECT wv_save_collection_v1(${JSON.stringify({ ...values, title, description, documentIds, inspection })}::jsonb) AS id`;
			id = result.id;
		} catch (cause) {
			const failure =
				cause.code === '23505'
					? {
							status: 409,
							message: '내 문서 묶음에 같은 제목이 있습니다. 다른 제목을 입력해 주세요.'
						}
					: writeFailure(cause);
			return fail(failure.status, { ...values, ...failure });
		}
		redirect(303, `/collections?open=${id}`);
	}
};
