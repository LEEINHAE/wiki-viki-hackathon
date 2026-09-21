import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { regexGovernance, validHandle } from '$lib/server/governance.js';
import { semanticGovernance, aiErrorMessage } from '$lib/server/openai.js';
import { renderWiki, buildToc, slugify } from '$lib/server/wiki.js';
import { fields } from '$lib/wiki-utils.js';

export async function load({ url }) {
	try {
		const drafts =
			await db()`SELECT * FROM drafts WHERE status <> 'published' ORDER BY created_at DESC`;
		const requested = Number(url.searchParams.get('open'));
		const selected = drafts.find((draft) => Number(draft.id) === requested) || null;
		return {
			drafts,
			selected,
			html: selected ? await renderWiki(selected.content) : '',
			toc: selected ? buildToc(selected.content) : [],
			updated: url.searchParams.has('updated'),
			notFound: !!requested && !selected
		};
	} catch (cause) {
		console.error('Draft load failed:', cause.message);
		return {
			drafts: [],
			selected: null,
			databaseError: '초안을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
		};
	}
}
async function inspect(title, content, description = '', aliases = [], generationMode = 'ai') {
	const regex = regexGovernance([title, content, description, aliases.join(', ')].join('\n'));
	const semantic =
		regex.passed && generationMode === 'ai'
			? await semanticGovernance(content)
			: { passed: regex.passed, reasons: [], skipped: true };
	return { passed: regex.passed && semantic.passed, regex, semantic, generationMode };
}
export const actions = {
	update: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		const id = Number(values.id);
		const title = String(values.title || '').trim();
		const content = String(values.content || '');
		const editor = String(values.editor || '').trim();
		const field = String(values.field || '일반');
		const description = String(values.description || '').trim();
		const aliases = String(values.aliases || '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);
		if (
			!title ||
			!content.trim() ||
			!slugify(title) ||
			!validHandle(editor) ||
			!fields.includes(field)
		)
			return fail(400, {
				...values,
				editing: true,
				message: '제목, 내용, 분야와 올바른 익명 이름을 입력해 주세요.'
			});
		try {
			const [existing] =
				await db()`SELECT governance FROM drafts WHERE id=${id} AND status <> 'published'`;
			if (!existing) return fail(404, { message: '초안이 이미 게시되었거나 삭제되었습니다.' });
			const governance = await inspect(
				title,
				content,
				description,
				aliases,
				existing.governance?.generationMode || 'ai'
			);
			const rows =
				await db()`UPDATE drafts SET title=${title},slug=${slugify(title)},content=${content},editor_handle=${editor},field=${field},description=${description},aliases=${JSON.stringify(aliases)}::jsonb,governance=${JSON.stringify(governance)}::jsonb,status=${governance.passed ? 'review' : 'blocked'},updated_at=NOW() WHERE id=${id} AND status <> 'published' RETURNING id`;
			if (!rows.length) return fail(404, { message: '초안이 이미 게시되었거나 삭제되었습니다.' });
		} catch (cause) {
			return fail(500, {
				...values,
				editing: true,
				message: cause.status
					? aiErrorMessage(cause)
					: '검토 내용을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'
			});
		}
		redirect(303, `/drafts?open=${id}&updated=1`);
	},
	publish: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		const editor = String(form.get('editor') || 'Operator-07');
		if (!validHandle(editor))
			return fail(400, { message: '올바른 익명 검토자 이름을 입력해 주세요.' });
		if (form.get('reviewed') !== 'yes')
			return fail(400, { message: '원문과 초안을 검토한 뒤 게시 확인을 선택해 주세요.' });
		let published;
		try {
			const sql = db();
			const [draft] =
				await sql`SELECT *,updated_at::text AS version FROM drafts WHERE id=${id} AND status <> 'published'`;
			if (!draft) return fail(404, { message: '초안이 이미 게시되었거나 삭제되었습니다.' });
			const governance = await inspect(
				draft.title,
				draft.content,
				draft.description,
				draft.aliases,
				draft.governance?.generationMode || 'ai'
			);
			if (!governance.passed) {
				await sql`UPDATE drafts SET status='blocked',governance=${JSON.stringify(governance)}::jsonb,updated_at=NOW() WHERE id=${id} AND status <> 'published'`;
				return fail(400, {
					message: '콘텐츠 검사로 게시가 차단되었습니다. 내용을 수정한 뒤 다시 검토해 주세요.'
				});
			}
			// Claim the reviewed version and create the document/revision/aliases atomically.
			[published] = await sql`
    WITH created AS (
     INSERT INTO documents (slug,title,content,editor_handle,field,description,source_name)
     SELECT slug,title,content,${editor},field,description,source_name FROM drafts
     WHERE id=${id} AND status <> 'published' AND updated_at=${draft.version}::timestamptz
     ON CONFLICT DO NOTHING RETURNING *
    ), revision AS (
     INSERT INTO revisions (document_id,content,editor_handle,summary)
     SELECT id,content,${editor},${`AI 초안 ${id} 검토 후 게시`} FROM created
    ), aliases AS (
     INSERT INTO redirects (alias_slug,alias_title,document_id)
     SELECT a.slug,a.title,c.id FROM created c CROSS JOIN jsonb_to_recordset(${JSON.stringify((draft.aliases || []).map((title) => ({ title, slug: slugify(title) })).filter((a) => a.slug && a.slug !== draft.slug))}::jsonb) AS a(slug text,title text)
     ON CONFLICT DO NOTHING
    ), completed AS (
     UPDATE drafts SET status='published',editor_handle=${editor},governance=${JSON.stringify(governance)}::jsonb,updated_at=NOW()
     WHERE id=${id} AND EXISTS (SELECT 1 FROM created)
    ) SELECT slug FROM created`;
			if (!published)
				return fail(409, {
					message:
						'같은 제목의 문서가 이미 있거나 초안이 변경되었습니다. 내용을 새로 확인하고, 기존 문서가 있다면 해당 문서에서 편집해 주세요.'
				});
		} catch (cause) {
			console.error('Draft publish failed:', cause.status || cause.code || cause.name);
			return fail(500, {
				message: cause.status
					? aiErrorMessage(cause)
					: '문서를 게시하지 못했습니다. 잠시 후 다시 시도해 주세요.'
			});
		}
		redirect(303, `/wiki/${encodeURIComponent(published.slug)}`);
	},
	delete: async ({ request }) => {
		const id = Number((await request.formData()).get('id'));
		await db()`DELETE FROM drafts WHERE id=${id} AND status <> 'published'`;
		redirect(303, '/drafts');
	}
};
