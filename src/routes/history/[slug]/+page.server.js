import { actorHandle } from '$lib/server/auth.js';
import { error, fail, redirect } from '@sveltejs/kit';
import { diffLines } from 'diff';
import { db } from '$lib/server/db.js';
import { getDocument } from '$lib/server/wiki.js';
import { persistDocument, writeFailure } from '$lib/server/persistence.js';
import { inspectContent, validHandle } from '$lib/server/governance.js';
import { semanticGovernance } from '$lib/server/openai.js';
import { metadataChanges, hasFullState } from '$lib/document-state.js';
import { permits } from '$lib/auth-policy.js';

export async function load({ params, url, locals }) {
	const result = await getDocument(params.slug, {
		followMerges: false,
		includeDeleted: locals.user?.role === 'admin'
	});
	if (!result) error(404, '문서를 찾을 수 없습니다.');
	const sql = db();
	const id = result.document.id;
	const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
	const [revisions, counts] = await Promise.all([
		sql`SELECT id,editor_handle,summary,created_at,COALESCE(to_jsonb(r)->'details','{}'::jsonb) AS details FROM wv_visible_revisions r WHERE document_id=${id} ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`,
		sql`SELECT count(*) AS count FROM wv_visible_revisions WHERE document_id=${id}`
	]);
	const numeric = (key) =>
		/^\d+$/.test(url.searchParams.get(key) || '') ? url.searchParams.get(key) : null;
	const selected = numeric('to') || numeric('diff');
	let from = numeric('from');
	let changes = [];
	let metadata = [];
	let rollback = null;
	const preview = numeric('restore');
	if (selected) {
		const [target] =
			await sql`SELECT id,content,document_state,created_at::text AS version FROM wv_visible_revisions WHERE document_id=${id} AND id=${selected}::bigint`;
		if (!target) error(404, '비교할 리비전을 찾을 수 없습니다.');
		const [previous] = from
			? await sql`SELECT id,content,document_state FROM wv_visible_revisions WHERE document_id=${id} AND id=${from}::bigint`
			: await sql`SELECT id,content,document_state FROM wv_visible_revisions WHERE document_id=${id} AND (created_at,id)<(${target.version}::text::timestamptz,${target.id}::bigint) ORDER BY created_at DESC,id DESC LIMIT 1`;
		if (from && !previous) error(404, '비교할 이전 리비전을 찾을 수 없습니다.');
		from = previous?.id || null;
		changes = diffLines(previous?.content || '', target.content);
		metadata = metadataChanges(previous?.document_state, target.document_state);
	}
	if (preview) {
		const [target] =
			await sql`SELECT id,content,document_state FROM wv_visible_revisions WHERE document_id=${id} AND id=${preview}::bigint`;
		if (!target) error(404, '복원할 리비전을 찾을 수 없습니다.');
		const [current] = await sql`SELECT wv_document_state_v1(${id}::bigint) AS state`;
		rollback = {
			id: target.id,
			changes: diffLines(result.document.content, target.content),
			metadata: metadataChanges(current.state, target.document_state),
			full: hasFullState(target.document_state)
		};
	}
	return {
		document: result.document,
		revisions,
		selected,
		from,
		changes,
		metadata,
		canRollback: permits(locals.user?.role, 'reviewer') || locals.demo,
		canRestoreState: locals.user?.role === 'admin',
		rollback,
		page,
		total: Number(counts[0].count)
	};
}
export const actions = {
	restoreState: async ({ request, params, locals }) => {
		if (locals.user?.role !== 'admin')
			return fail(403, { message: '전체 상태 복원에는 운영 권한이 필요합니다.' });
		const values = Object.fromEntries(await request.formData());
		if (!/^\d+$/.test(String(values.revision)) || values.reviewed !== 'yes')
			return fail(400, { message: '복원할 리비전과 확인 항목을 선택해 주세요.' });
		let saved;
		try {
			const result = await getDocument(params.slug, { followMerges: false, includeDeleted: true });
			if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
			const [revision] =
				await db()`SELECT content,document_state FROM wv_visible_revisions WHERE id=${String(values.revision)}::bigint AND document_id=${result.document.id}`;
			if (!revision || !hasFullState(revision.document_state))
				return fail(409, {
					message: '이 리비전에는 전체 상태 기록이 없습니다. 본문 되돌리기를 이용해 주세요.'
				});
			const s = revision.document_state;
			const inspection = await inspectContent(
				[
					s.title,
					revision.content,
					s.description,
					s.sourceName,
					...s.aliases.map((a) => a.title),
					...s.tags
				],
				semanticGovernance
			);
			if (!inspection.passed)
				return fail(400, {
					message: '복원할 내용의 콘텐츠 검사에 실패했습니다. 본문을 직접 수정해 주세요.'
				});
			const [row] =
				await db()`SELECT wv_restore_document_state_v1(${JSON.stringify({ id: result.document.id, version: values.version, revisionId: values.revision, editor: locals.user.handle, inspection, reviewed: values.reviewed })}::jsonb) AS result`;
			saved = row.result;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, `/history/${encodeURIComponent(saved.slug)}?diff=${saved.revisionId}`);
	},
	rollback: async ({ request, params }) => {
		const form = await request.formData();
		const id = Number(form.get('revision'));
		const editor = actorHandle(String(form.get('editor') || ''));
		if (!validHandle(editor)) return fail(400, { message: '익명 편집자 이름을 확인해 주세요.' });
		const result = await getDocument(params.slug, { followMerges: false });
		if (!result) return fail(404);
		const [revision] =
			await db()`SELECT content FROM wv_visible_revisions WHERE id=${id} AND document_id=${result.document.id}`;
		if (!revision) return fail(404, { message: '리비전을 찾을 수 없습니다.' });
		const aliases =
			await db()`SELECT alias_title FROM redirects WHERE document_id=${result.document.id}`;
		try {
			const governance = await inspectContent(
				[
					result.document.title,
					revision.content,
					result.document.description,
					result.document.source_name,
					...aliases.map((a) => a.alias_title)
				],
				semanticGovernance
			);
			if (!governance.passed)
				return fail(400, {
					message: '이전 본문의 콘텐츠 검사에 실패했습니다. 본문을 직접 수정해 주세요.'
				});
			await persistDocument({
				id: result.document.id,
				version: String(form.get('version') || ''),
				title: result.document.title,
				content: revision.content,
				editor,
				summary: `리비전 ${id}(으)로 되돌림`,
				slug: result.document.slug,
				field: result.document.field,
				description: result.document.description,
				sourceName: result.document.source_name,
				aliases: aliases.map((a) => a.alias_title),
				governance
			});
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, `/wiki/${result.document.slug}`);
	}
};
