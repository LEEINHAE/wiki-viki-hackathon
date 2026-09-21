import { actorHandle } from '$lib/server/auth.js';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { inspectContent, validHandle } from '$lib/server/governance.js';
import { semanticGovernance, aiErrorMessage } from '$lib/server/openai.js';
import { renderWiki, buildToc, slugify } from '$lib/server/wiki.js';
import { fields, wikiTargets } from '$lib/wiki-utils.js';
import { aliasRecords, writeFailure } from '$lib/server/persistence.js';
import { mergeActions } from '$lib/server/draft-merge.js';
import { diffLines } from 'diff';

export async function load({ url }) {
	try {
		const sql = db();
		const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page')) || 1));
		const status = ['review', 'blocked'].includes(url.searchParams.get('status'))
			? url.searchParams.get('status')
			: '';
		const requested = Number(url.searchParams.get('open'));
		const targetQuery = (url.searchParams.get('targetQ') || '').trim().slice(0, 200);
		const [drafts, selectedRows, counts] = await Promise.all([
			sql`SELECT id,title,slug,description,source_name,status,created_at,updated_at,updated_at::text AS version,governance->'review' AS review FROM wv_visible_drafts WHERE status<>'published' AND (${status}='' OR status=${status}) ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`,
			requested
				? sql`SELECT *,updated_at::text AS version FROM wv_visible_drafts WHERE id=${requested} AND status<>'published'`
				: [],
			sql`SELECT count(*) AS count FROM wv_visible_drafts WHERE status<>'published' AND (${status}='' OR status=${status})`
		]);
		const selected = selectedRows[0] || null;
		const names = new Set(selected ? [selected.title, ...selected.aliases].map(slugify) : []);
		const namesList = [...names];
		const targets = selected
			? await sql`SELECT d.id,d.title,d.slug,COALESCE((SELECT jsonb_agg(r.alias_title) FROM wv_resolved_names r WHERE r.document_id=d.id),'[]'::jsonb) AS aliases,
      (d.slug=ANY(${namesList}) OR EXISTS(SELECT 1 FROM wv_resolved_names r WHERE r.document_id=d.id AND r.alias_slug=ANY(${namesList}))) AS recommended
      FROM wv_current_documents d WHERE d.deleted_at IS NULL AND (${targetQuery}='' OR position(wv_normalize_v1(${targetQuery}) IN wv_normalize_v1(d.title))>0 OR EXISTS(SELECT 1 FROM wv_resolved_names r WHERE r.document_id=d.id AND position(wv_normalize_v1(${targetQuery}) IN wv_normalize_v1(r.alias_title))>0) OR d.id=${selected.governance?.merge?.targetId || null})
      ORDER BY recommended DESC,d.title LIMIT 50`
			: [];

		const [sources, siblings] = await Promise.all([
			selected
				? sql`SELECT s.id,s.kind,s.position,s.label,s.text FROM wv_draft_sources ds JOIN wv_upload_sources s ON s.id=ds.source_id WHERE ds.draft_id=${selected.id} ORDER BY s.ordinal`
				: [],
			selected?.wv_upload_job_id
				? sql`SELECT id,title,status FROM wv_visible_drafts WHERE wv_upload_job_id=${selected.wv_upload_job_id} ORDER BY id`
				: []
		]);
		const wanted = selected ? wikiTargets(selected.content) : [];
		const found = wanted.length
			? await sql`SELECT slug FROM wv_current_documents WHERE deleted_at IS NULL AND slug=ANY(${wanted.map(slugify)}) UNION SELECT r.alias_slug AS slug FROM wv_resolved_names r JOIN wv_current_documents d ON d.id=r.document_id WHERE d.deleted_at IS NULL AND r.alias_slug=ANY(${wanted.map(slugify)})`
			: [];
		const known = new Set(found.map((r) => r.slug));
		return {
			missingLinks: wanted.filter((title) => !known.has(slugify(title))),
			sources,
			siblings,
			drafts,
			page,
			status,
			total: Number(counts[0].count),
			targetQuery,
			selected,
			targets: targets.map((target) => ({
				...target,
				recommended:
					target.recommended ||
					[target.title, target.slug, ...target.aliases].some((name) => names.has(slugify(name)))
			})),
			mergeDiff: selected?.governance?.merge
				? diffLines(selected.governance.merge.previousContent, selected.governance.merge.content)
				: [],
			html: selected ? await renderWiki(selected.content) : '',
			toc: selected ? buildToc(selected.content) : [],
			updated: url.searchParams.has('updated'),
			batchPublished: Number(url.searchParams.get('published')) || 0,
			notFound: !!requested && !selected
		};
	} catch (cause) {
		console.error('Draft load failed:', cause.code || cause.name);
		return {
			drafts: [],
			selected: null,
			databaseError: '초안을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
		};
	}
}
async function inspect(
	title,
	content,
	description = '',
	aliases = [],
	generationMode = 'ai',
	sourceName = '',
	tags = []
) {
	const result = await inspectContent(
		[title, content, description, ...aliases, sourceName, ...tags],
		semanticGovernance
	);
	return { ...result, generationMode };
}
export const actions = {
	...mergeActions,
	markReviewed: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		if (values.reviewed !== 'yes' || !validHandle(values.editor))
			return fail(400, { message: '원문 검토 확인과 검토자 이름이 필요합니다.' });
		try {
			const rows =
				await db()`UPDATE wv_visible_drafts SET governance=governance||jsonb_build_object('review',jsonb_build_object('version',updated_at::text,'editor',${values.editor}::text,'at',clock_timestamp())) WHERE id=${values.id} AND status='review' AND updated_at=${String(values.version || '')}::text::timestamptz RETURNING id`;
			if (!rows.length)
				return fail(409, {
					message: '초안이 변경되었거나 차단되었습니다. 최신 내용을 다시 검토해 주세요.'
				});
		} catch {
			return fail(503, { message: '검토 기록을 저장하지 못했습니다. 다시 시도해 주세요.' });
		}
		redirect(303, '/drafts');
	},
	publishSelected: async ({ request }) => {
		const form = await request.formData();
		const selected = form.getAll('selected').map(String);
		const editor = actorHandle(String(form.get('editor') || ''));
		if (
			!validHandle(editor) ||
			form.get('confirmed') !== 'yes' ||
			!selected.length ||
			selected.length > 8 ||
			selected.some((v) => !/^\d+\|.+$/.test(v))
		)
			return fail(400, { message: '검토한 초안 1~8개를 선택하고 게시 확인을 해 주세요.' });
		try {
			const records = [];
			for (const choice of selected) {
				const [id, version] = choice.split('|');
				const [draft] =
					await db()`SELECT *,updated_at::text AS version FROM wv_visible_drafts WHERE id=${id}::bigint AND status='review'`;
				if (!draft || draft.version !== version || draft.governance?.review?.version !== version)
					return fail(409, {
						message:
							'선택한 초안이 변경되었습니다. 전체 게시를 취소했습니다. 각 초안을 다시 검토해 주세요.'
					});
				const inspection = await inspect(
					draft.title,
					draft.content,
					draft.description,
					draft.aliases,
					draft.governance?.generationMode,
					draft.source_name,
					draft.tags
				);
				if (!inspection.passed)
					return fail(400, {
						message: '선택한 초안에 차단된 내용이 있습니다. 게시하지 않았습니다.'
					});
				records.push({
					id,
					version,
					inspection: { ...inspection, aliasRecords: aliasRecords(draft.aliases) }
				});
			}
			await db()`SELECT wv_publish_selected_v1(${JSON.stringify(records)}::jsonb,${editor})`;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, `/drafts?published=${selected.length}`);
	},
	update: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		const id = Number(values.id);
		const title = String(values.title || '').trim();
		const content = String(values.content || '');
		const editor = String(values.editor || '').trim();
		const field = String(values.field || '일반');
		const description = String(values.description || '').trim();
		const tags = [
			...new Set(
				String(values.tags || '')
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			)
		];
		const aliases = String(values.aliases || '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);
		if (
			tags.length > 20 ||
			tags.some((t) => t.length > 40) ||
			description.length > 2000 ||
			String(values.aliases || '').length > 5000 ||
			content.length > 200000 ||
			title.length > 200 ||
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
				await db()`SELECT governance,source_name FROM wv_visible_drafts WHERE id=${id} AND status <> 'published'`;
			if (!existing) return fail(404, { message: '초안이 이미 게시되었거나 삭제되었습니다.' });
			const governance = await inspect(
				title,
				content,
				description,
				aliases,
				existing.governance?.generationMode || 'ai',
				existing.source_name,
				tags
			);
			const rows =
				await db()`UPDATE wv_visible_drafts SET title=${title},slug=${slugify(title)},content=${content},editor_handle=${editor},field=${field},description=${description},tags=${JSON.stringify(tags)}::jsonb,aliases=${JSON.stringify(aliases)}::jsonb,governance=(governance-'merge')||${JSON.stringify(governance)}::jsonb,status=${governance.passed ? 'review' : 'blocked'},updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${id} AND status <> 'published' AND updated_at=${String(values.version || '')}::text::timestamptz RETURNING id`;
			if (!rows.length)
				return fail(409, {
					...values,
					editing: true,
					message: '초안이 변경되었습니다. 내 입력은 유지됩니다. 최신 초안을 확인해 주세요.'
				});
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
		const editor = actorHandle(String(form.get('editor') || 'Operator-07'));
		if (!validHandle(editor))
			return fail(400, { message: '올바른 익명 검토자 이름을 입력해 주세요.' });
		if (form.get('reviewed') !== 'yes')
			return fail(400, { message: '원문과 초안을 검토한 뒤 게시 확인을 선택해 주세요.' });
		let published;
		try {
			const sql = db();
			const [draft] =
				await sql`SELECT *,updated_at::text AS version FROM wv_visible_drafts WHERE id=${id} AND status <> 'published'`;
			if (!draft) return fail(404, { message: '초안이 이미 게시되었거나 삭제되었습니다.' });
			if (String(form.get('version') || '') !== draft.version)
				return fail(409, { message: '초안이 변경되었습니다. 최신 내용을 다시 검토해 주세요.' });
			const governance = await inspect(
				draft.title,
				draft.content,
				draft.description,
				draft.aliases,
				draft.governance?.generationMode || 'ai',
				draft.source_name,
				draft.tags
			);
			if (!governance.passed) {
				await sql`UPDATE wv_visible_drafts SET status='blocked',governance=(governance-'merge')||${JSON.stringify(governance)}::jsonb,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${id} AND status <> 'published' AND updated_at=${draft.version}::text::timestamptz`;
				return fail(400, {
					message: '콘텐츠 검사로 게시가 차단되었습니다. 내용을 수정한 뒤 다시 검토해 주세요.'
				});
			}
			const [row] =
				await sql`SELECT wv_publish_draft_v1(${id},${draft.version},${editor},${JSON.stringify({ ...governance, aliasRecords: aliasRecords(draft.aliases) })}::jsonb) AS document`;
			published = row.document;
		} catch (cause) {
			const failure = cause.status
				? { status: 503, message: aiErrorMessage(cause) }
				: writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, `/wiki/${encodeURIComponent(published.slug)}`);
	},
	delete: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		try {
			const rows =
				await db()`DELETE FROM wv_visible_drafts WHERE id=${values.id} AND status <> 'published' AND updated_at=${String(values.version || '')}::text::timestamptz RETURNING id`;
			if (!rows.length)
				return fail(409, {
					message: '초안이 변경되었거나 게시되었습니다. 최신 내용을 확인해 주세요.'
				});
		} catch {
			return fail(500, { message: '초안을 삭제하지 못했습니다. 다시 시도해 주세요.' });
		}
		redirect(303, '/drafts');
	}
};
