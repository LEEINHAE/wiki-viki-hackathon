import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, saveDocument, slugify } from '$lib/server/wiki.js';
import { validHandle, regexGovernance } from '$lib/server/governance.js';
import { fields } from '$lib/wiki-utils.js';

export async function load({ params, url }) {
	try {
		const result = await getDocument(params.slug);
		const aliases = result
			? await db()`SELECT alias_title FROM redirects WHERE document_id=${result.document.id} ORDER BY alias_title`
			: [];
		return {
			slug: params.slug,
			document: result?.document || null,
			suggestedTitle: url.searchParams.get('title'),
			aliases: aliases.map((row) => row.alias_title).join(', ')
		};
	} catch {
		return {
			slug: params.slug,
			document: null,
			databaseError: '문서를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.'
		};
	}
}
export const actions = {
	save: async ({ request, params }) => {
		const values = Object.fromEntries(await request.formData());
		const title = String(values.title || '').trim();
		const content = String(values.content || '');
		const editor = String(values.editor || '').trim();
		const summary = String(values.summary || '').trim();
		const aliases = String(values.aliases || '');
		const field = String(values.field || '일반');
		const description = String(values.description || '').trim();
		const sourceName = String(values.sourceName || '').trim();
		const invalid = (status, message) => fail(status, { ...values, message });
		if (!title || !content.trim() || !slugify(title))
			return invalid(400, '제목과 내용을 모두 입력해 주세요.');
		if (!validHandle(editor))
			return invalid(400, 'Operator-07 또는 Editor-01 형식의 익명 이름을 사용해 주세요.');
		if (!fields.includes(field)) return invalid(400, '올바른 분야를 선택해 주세요.');
		const governance = regexGovernance(
			[title, content, description, sourceName, aliases].join('\n')
		);
		if (!governance.passed)
			return invalid(
				400,
				`콘텐츠 보호 검사로 저장이 차단되었습니다: ${governance.reasons.join(', ')}`
			);
		let document;
		try {
			const existing = await getDocument(params.slug);
			// Resolve aliases before saving so editing a redirect cannot create a second document.
			document = await saveDocument({
				title,
				content,
				editor,
				summary,
				originalSlug: existing?.document.slug || slugify(title),
				field,
				description,
				sourceName
			});
			const sql = db();
			const names = [
				...new Set(
					aliases
						.split(',')
						.map((alias) => alias.trim())
						.filter((alias) => alias && slugify(alias) && slugify(alias) !== document.slug)
				)
			];
			await sql.transaction([
				sql`DELETE FROM redirects WHERE document_id=${document.id}`,
				...names.map(
					(alias) =>
						sql`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES (${slugify(alias)},${alias},${document.id}) ON CONFLICT (alias_slug) DO NOTHING`
				)
			]);
		} catch (cause) {
			console.error('Document save failed:', cause.message);
			return invalid(
				500,
				'문서를 저장하지 못했습니다. 같은 제목이 있는지 확인한 뒤 다시 시도해 주세요.'
			);
		}
		redirect(303, `/wiki/${encodeURIComponent(document.slug)}`);
	},
	delete: async ({ params }) => {
		const result = await getDocument(params.slug);
		if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
		await db()`DELETE FROM documents WHERE id=${result.document.id}`;
		redirect(303, '/');
	}
};
