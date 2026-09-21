import { actorHandle } from '$lib/server/auth.js';
import { env } from '$env/dynamic/private';
import { acquireAIRequest } from './ai-limits.js';
import { assertSafeForAI } from './governance.js';
import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { db } from './db.js';
import { mergeDocuments, semanticGovernance, aiErrorMessage } from './openai.js';
import { draftFingerprint } from './merge-contract.js';
import { inspectContent, validHandle, ContentBlockedError } from './governance.js';
import { aliasRecords, writeFailure } from './persistence.js';

async function reviewedDraft(values) {
	const [draft] =
		await db()`SELECT *,updated_at::text AS version FROM wv_visible_drafts WHERE id=${values.id} AND status<>'published'`;
	if (!draft) throw new Error('draft_missing');
	if (!values.version || values.version !== draft.version) throw new Error('version_conflict');
	return draft;
}
function failure(cause, values) {
	const result =
		cause instanceof ContentBlockedError || cause.name === 'AIUnavailableError'
			? { status: 400, message: cause.message }
			: cause.status
				? { status: 503, message: aiErrorMessage(cause) }
				: writeFailure(cause);
	return fail(result.status, { ...values, mergeContent: values.content, ...result });
}
export const mergeActions = {
	prepareMerge: async ({ request, getClientAddress }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		let lease;
		try {
			const draft = await reviewedDraft(values);
			const [target] =
				await db()`SELECT *,updated_at::text AS version FROM wv_current_documents WHERE id=${values.targetId} AND deleted_at IS NULL AND wv_archived_at IS NULL`;
			if (!target) throw new Error('document_missing');
			const aliases = await db()`SELECT alias_title FROM redirects WHERE document_id=${target.id}`;
			assertSafeForAI(
				target.title,
				target.content,
				target.description,
				target.source_name,
				...aliases.map((a) => a.alias_title),
				draft.title,
				draft.content,
				draft.description,
				draft.source_name,
				...draft.aliases,
				...(draft.tags || [])
			);
			if (env.OPENAI_API_KEY) {
				lease = await acquireAIRequest(
					getClientAddress(),
					`merge:${draft.id}:${draft.version}:${target.id}:${target.version}`
				);
				if (lease.error)
					return fail(429, {
						message:
							lease.error === 'duplicate'
								? '같은 통합안을 이미 생성 중입니다. 완료 후 확인해 주세요.'
								: 'AI 요청이 많습니다. 최대 10분 후 다시 시도해 주세요.'
					});
			}
			const generated = await mergeDocuments(target, draft, { signal: request.signal });
			const plan = {
				...generated,
				id: randomUUID(),
				targetId: target.id,
				targetTitle: target.title,
				targetSlug: target.slug,
				targetVersion: target.version,
				previousContent: target.content,
				draftFingerprint: draftFingerprint(draft)
			};
			const rows =
				await db()`UPDATE wv_visible_drafts SET wv_min_role=${['editor', 'reviewer', 'admin'][Math.max(['editor', 'reviewer', 'admin'].indexOf(draft.wv_min_role), ['editor', 'reviewer', 'admin'].indexOf(target.wv_min_role))]},governance=governance||${JSON.stringify({ merge: plan })}::jsonb,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${draft.id} AND status<>'published' AND updated_at=${draft.version}::text::timestamptz RETURNING id`;
			if (!rows.length) throw new Error('version_conflict');
		} catch (cause) {
			return failure(cause, values);
		} finally {
			if (lease?.release) await lease.release().catch(() => {});
		}
		redirect(303, `/drafts?open=${values.id}`);
	},
	discardMerge: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		try {
			const rows =
				await db()`UPDATE wv_visible_drafts SET governance=governance-'merge',updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=${values.id} AND status<>'published' AND updated_at=${String(values.version || '')}::text::timestamptz RETURNING id`;
			if (!rows.length) throw new Error('version_conflict');
		} catch (cause) {
			return failure(cause, values);
		}
		redirect(303, `/drafts?open=${values.id}`);
	},
	applyMerge: async ({ request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		let result;
		if (!validHandle(values.editor) || values.reviewed !== 'yes')
			return fail(400, {
				...values,
				mergeContent: values.content,
				message: '익명 검토자 이름과 본문·상충 검토 확인이 필요합니다.'
			});
		if (!String(values.content || '').trim() || String(values.content).length > 200000)
			return fail(400, {
				...values,
				mergeContent: values.content,
				message: '통합 본문은 1~20만 자로 입력해 주세요.'
			});
		try {
			const draft = await reviewedDraft(values);
			const plan = draft.governance?.merge;
			if (!plan || plan.id !== values.mergeId || plan.draftFingerprint !== draftFingerprint(draft))
				throw new Error('version_conflict');
			const [target] =
				await db()`SELECT *,updated_at::text AS version FROM wv_current_documents WHERE id=${plan.targetId} AND deleted_at IS NULL AND wv_archived_at IS NULL`;
			if (!target) throw Error('document_missing');
			if (target.version !== plan.targetVersion) throw Error('version_conflict');
			const aliases = await db()`SELECT alias_title FROM redirects WHERE document_id=${target.id}`;
			const inspection = await inspectContent(
				[
					target.title,
					values.content,
					target.description,
					target.source_name,
					...aliases.map((a) => a.alias_title),
					draft.source_name,
					...draft.aliases,
					...(draft.tags || [])
				],
				semanticGovernance
			);
			if (!inspection.passed) throw new Error('content_blocked');
			const payload = {
				draftId: draft.id,
				version: draft.version,
				mergeId: plan.id,
				draftFingerprint: draftFingerprint(draft),
				content: values.content,
				editor: values.editor,
				inspection,
				aliases: aliasRecords([draft.title, ...draft.aliases])
			};
			const [row] =
				await db()`SELECT wv_apply_draft_merge_v1(${JSON.stringify(payload)}::jsonb) AS document`;
			result = row.document;
		} catch (cause) {
			return failure(cause, values);
		}
		redirect(303, `/wiki/${encodeURIComponent(result.slug)}`);
	}
};
