import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { readLinkSnapshot } from '$lib/server/document-links.js';
import { validHandle, ContentBlockedError } from '$lib/server/governance.js';
import { inspectDocumentContent } from '$lib/server/document-governance.js';
import { slugify, renderWiki } from '$lib/server/wiki.js';
import { reviewVersion, publicationAliases, publishDraft } from '$lib/server/draft-publication.js';
import {
	validDraftId,
	validDraftVersion,
	getDraft,
	changeDraft,
	deleteDraftBatch
} from '$lib/server/draft-write.js';
import { getEditableDocument } from '$lib/server/document-write.js';
import { mergeAvailable, generateMerge, MergeError } from '$lib/server/merge-ai.js';
import { mergeHistory, mergeHistoryInspection, normalizeMergeText } from '$lib/merge-history.js';
import {
	batchReviewLimit,
	batchDeleteLimit,
	batchReviewReason,
	reviewListPage,
	publicationConflictMessage
} from '$lib/draft-review.js';
import {
	proposalMatches,
	mergeAliases,
	hasMergeEdits,
	applyMerge
} from '$lib/server/merge-application.js';
import {
	listMergeTargets,
	createProposal,
	reviewProposal,
	saveProposal
} from '$lib/server/draft-merge.js';

export async function load({ url }) {
	try {
		const sql = db();
		const drafts = (
			await sql`SELECT d.*, (to_jsonb(d) - 'id')::text AS snapshot
				FROM drafts d WHERE status <> 'published' ORDER BY created_at DESC,id DESC`
		).map(({ snapshot, ...draft }) => ({ ...draft, version: reviewVersion(snapshot) }));
		const requested = url.searchParams.get('open');
		const selected = drafts.find((draft) => String(draft.id) === requested) || null;
		const targets = selected ? await listMergeTargets(sql, selected) : [];
		const reviewList = reviewListPage(drafts, url);
		const { catalog } = await readLinkSnapshot();
		if (!selected) {
			reviewList.items = await Promise.all(
				reviewList.items.map(async (draft) => ({
					...draft,
					previewHtml: await renderWiki(
						draft.content,
						drafts,
						{},
						{
							anchorPrefix: `draft-${draft.id}-`,
							sourceSlug: draft.slug,
							catalog,
							imageLinks: true
						}
					)
				}))
			);
		}
		return {
			drafts,
			reviewList,
			selected,
			targets,
			mergeAvailable: mergeAvailable(),
			proposal: selected ? reviewProposal(selected, targets) : null,
			missingSelection: !!requested && !selected,
			previewHtml: selected
				? await renderWiki(
						selected.content,
						drafts,
						{},
						{
							sourceSlug: selected.slug,
							catalog,
							anchorPrefix: `draft-${selected.id}-stored-`,
							imageLinks: true
						}
					)
				: '',
			siblings: selected
				? drafts
						.filter(
							(draft) =>
								draft.id !== selected.id &&
								draft.source_name === selected.source_name &&
								new Date(draft.created_at).getTime() === new Date(selected.created_at).getTime()
						)
						.map(({ id, title }) => ({ id, title }))
				: []
		};
	} catch {
		return { drafts: [], selected: null, databaseError: '초안을 불러오지 못했습니다.' };
	}
}

function submittedValues(form, action) {
	const values = { action };
	for (const key of [
		'id',
		'version',
		'title',
		'content',
		'aliases',
		'editor',
		'target',
		'proposalId',
		'finalContent',
		'mergeEditor'
	])
		if (form.has(key)) values[key] = form.get(key)?.toString() || '';
	values.id ??= '';
	values.version ??= '';
	return values;
}
const parseAliases = (text) =>
	text
		.split(/\r?\n/)
		.map((alias) => alias.trim())
		.filter(Boolean);

const replaceMergeMessage =
	'편집 중인 최종 통합 본문·검토자를 유지했습니다. 다른 초안 작업으로 진행하려면 최종 편집을 버리는 확인 항목을 선택해 주세요.';
const canReplaceMerge = (form, draft) =>
	!hasMergeEdits(form, draft) || form.get('confirmResetMerge') === 'yes';

async function applyMergeAction({ request }) {
	const form = await request.formData();
	const values = submittedValues(form, 'applyMerge');
	const stale = () =>
		fail(409, {
			...values,
			refreshRequired: true,
			message:
				'초안·대상 문서 또는 통합안이 변경되었거나 이미 처리되었습니다. 최종 편집 입력을 유지했습니다. 최신 상태에서 통합안을 다시 검토해 주세요.'
		});
	if (!validDraftId(values.id) || !validDraftVersion(values.version))
		return fail(400, {
			...values,
			refreshRequired: true,
			message:
				'검토한 초안 버전을 확인할 수 없습니다. 입력을 보관하고 최신 초안을 다시 열어 주세요.'
		});
	if (form.get('confirmMerge') !== 'yes')
		return fail(400, {
			...values,
			message: '최종 본문과 상충 내용을 검토했다는 확인 항목을 선택해 주세요.'
		});
	const content = normalizeMergeText(values.finalContent || ''),
		editor = values.mergeEditor?.trim();
	if (!content.trim() || content.length > 200000 || !validHandle(editor))
		return fail(400, {
			...values,
			message: '200,000자 이하의 최종 본문과 올바른 익명 통합 검토자 이름을 입력해 주세요.'
		});
	let result;
	try {
		const sql = db(),
			draft = await getDraft(sql, values.id);
		if (!draft || draft.status === 'published' || draft.version !== values.version) return stale();
		if (
			form.has('content') &&
			(values.title?.trim() !== draft.title ||
				normalizeMergeText(values.content) !== normalizeMergeText(draft.content) ||
				values.editor?.trim() !== draft.editor_handle ||
				JSON.stringify(parseAliases(values.aliases || '')) !== JSON.stringify(draft.aliases))
		)
			return fail(400, {
				...values,
				message:
					'초안 수정 내용을 먼저 저장해 주세요. 저장하면 기존 통합안을 다시 생성해야 합니다. 최종 편집 입력은 유지했습니다.'
			});
		const proposal = draft.governance?.merge;
		if (!validDraftId(proposal?.targetId || '')) return stale();
		const target = await getEditableDocument('', proposal.targetId);
		if (!proposalMatches(draft, target, values.proposalId)) return stale();
		if (
			form.has('target') &&
			values.target !== `${proposal.targetId}:${proposal.targetFingerprint}`
		)
			return fail(400, {
				...values,
				message:
					'통합 대상 선택이 바뀌었습니다. 선택한 대상의 통합안을 다시 생성한 뒤 검토해 주세요. 최종 편집 입력은 유지했습니다.'
			});
		const aliases = mergeAliases(draft, target);
		if (!aliases)
			return fail(400, {
				...values,
				message: '초안의 제목·별칭 형식을 수정하고 통합안을 다시 생성해 주세요.'
			});
		const summary = mergeHistory(draft, proposal, content);
		const governance = await inspectDocumentContent({
			title: target.document.title,
			content,
			aliases: [
				...target.aliases.map((alias) => alias.alias_title),
				...aliases.map((alias) => alias.alias_title)
			],
			summary: mergeHistoryInspection(summary)
		});
		if (!governance.passed)
			return fail(governance.semantic.unavailable ? 503 : 400, {
				...values,
				mergeGovernance: governance,
				message: governance.semantic.unavailable
					? '콘텐츠 보호 검사를 완료하지 못해 통합하지 않았습니다. 최종 편집 입력을 유지했습니다.'
					: '콘텐츠 보호 검사로 통합을 차단했습니다. 최종 본문·별칭·출처와 상충 기록을 확인해 주세요.'
			});
		result = await applyMerge(sql, {
			draft,
			target,
			content,
			editor,
			aliases,
			governance,
			summary
		});
		if (result.status !== 'merged') return stale();
	} catch {
		return fail(503, {
			...values,
			message:
				'통합 결과를 확인하지 못했습니다. 최종 편집 입력을 유지했습니다. 문서와 초안 상태를 확인한 뒤 다시 시도해 주세요.'
		});
	}
	redirect(303, '/wiki/' + encodeURIComponent(result.slug));
}

async function mergeAction({ request }, discarding = false) {
	const form = await request.formData();
	const values = submittedValues(form, discarding ? 'discardMerge' : 'generateMerge');
	const changed = () =>
		fail(409, {
			...values,
			refreshRequired: true,
			message:
				'초안 또는 대상 문서가 변경되었습니다. 입력과 기존 통합안은 유지했습니다. 최신 상태를 다시 확인한 뒤 생성해 주세요.'
		});
	if (!validDraftId(values.id) || !validDraftVersion(values.version))
		return fail(400, {
			...values,
			refreshRequired: true,
			message: '초안의 검토 버전을 확인할 수 없습니다. 최신 초안을 다시 열어 주세요.'
		});
	try {
		const sql = db();
		const draft = await getDraft(sql, values.id);
		if (!draft || draft.status === 'published' || draft.version !== values.version)
			return changed();
		if (!canReplaceMerge(form, draft))
			return fail(400, { ...values, message: replaceMergeMessage });
		if (
			form.has('content') &&
			(values.title?.trim() !== draft.title ||
				values.content.replace(/\r\n/g, '\n') !== draft.content.replace(/\r\n/g, '\n') ||
				values.editor?.trim() !== draft.editor_handle ||
				JSON.stringify(parseAliases(values.aliases || '')) !== JSON.stringify(draft.aliases))
		)
			return fail(400, {
				...values,
				message: '작성 중인 수정 내용을 먼저 저장한 뒤 통합안을 생성하거나 버려 주세요.'
			});
		if (discarding) {
			if (!draft.governance?.merge || form.get('proposalId') !== draft.governance.merge.id)
				return changed();
			if (!(await saveProposal(sql, draft, null, null))) return changed();
		} else {
			const [targetId, targetVersion, extra] = (values.target || '').split(':');
			if (
				!validDraftId(targetId || '') ||
				!validDraftVersion(targetVersion || '') ||
				extra !== undefined
			)
				return fail(400, { ...values, message: '통합할 기존 문서를 선택해 주세요.' });
			const target = await getEditableDocument('', targetId);
			if (!target || target.version !== targetVersion) return changed();
			const generated = await generateMerge(target.document, draft);
			if (!(await saveProposal(sql, draft, target, createProposal(draft, target, generated))))
				return changed();
		}
	} catch (error) {
		if (error instanceof MergeError)
			return fail(error.status, {
				...values,
				message: error.message,
				...(error.recoveryBlocked ? { recoveryBlocked: true } : {})
			});
		if (error instanceof ContentBlockedError)
			return fail(400, {
				...values,
				recoveryBlocked: true,
				message:
					'콘텐츠 보호 검사로 통합안 생성을 중단했습니다. 두 문서 또는 생성 결과에 확인이 필요한 내용이 있습니다.'
			});
		return fail(503, {
			...values,
			message:
				'통합안 처리를 완료하지 못했습니다. 기존 내용은 유지했습니다. 상태를 확인한 뒤 다시 시도해 주세요.'
		});
	}
	redirect(303, '/drafts?open=' + values.id);
}

async function editDraft({ request }, deleting = false) {
	const form = await request.formData();
	const values = submittedValues(form, deleting ? 'delete' : 'update');
	if (!deleting && form.has('resolveVersion'))
		values.version = form.get('resolveVersion')?.toString() || '';
	if (!validDraftId(values.id) || !validDraftVersion(values.version))
		return fail(400, {
			...values,
			refreshRequired: true,
			message:
				'초안과 검토 버전을 확인할 수 없습니다. 입력을 보관하고 최신 초안을 다시 열어 주세요.'
		});
	if (deleting && form.get('confirmDelete') !== 'yes')
		return fail(400, { ...values, message: '저장된 초안의 영구 삭제 확인 항목을 선택해 주세요.' });
	const title = values.title?.trim(),
		content = values.content,
		editor = values.editor?.trim();
	if (
		!deleting &&
		(!title || !content?.trim() || !validHandle(editor) || !/[\p{L}\p{N}]/u.test(slugify(title)))
	)
		return fail(400, {
			...values,
			message: '제목, 본문 및 올바른 익명 검토자 이름을 입력해 주세요.'
		});
	if (!deleting && content.length > 200000)
		return fail(400, {
			...values,
			message: '초안 본문은 200,000자 이하로 저장해 주세요. 입력은 유지했습니다.'
		});
	try {
		const sql = db();
		const draft = await getDraft(sql, values.id);
		const changed = async () => {
			const current = await getDraft(sql, values.id);
			return fail(409, {
				...values,
				refreshRequired: true,
				message:
					'초안이 변경되었거나 이미 게시·삭제되어 처리하지 않았습니다. 입력을 유지했습니다. 최신 상태를 다시 확인해 주세요.',
				conflict:
					!deleting && current && current.status !== 'published'
						? {
								title: current.title,
								content: current.content,
								aliases: current.aliases,
								editor: current.editor_handle,
								version: current.version
							}
						: null
			});
		};
		if (!draft || draft.status === 'published' || draft.version !== values.version)
			return await changed();
		if (!deleting && !canReplaceMerge(form, draft))
			return fail(400, { ...values, message: replaceMergeMessage });
		if (deleting) {
			if (!(await changeDraft(sql, draft))) return await changed();
		} else {
			const aliases = form.has('aliases') ? parseAliases(values.aliases) : draft.aliases;
			const governance = await inspectDocumentContent({ title, content, aliases });
			if (!(await changeDraft(sql, draft, { title, content, aliases, editor }, governance)))
				return await changed();
		}
	} catch {
		return fail(503, {
			...values,
			message:
				'초안 처리 결과를 확인하지 못했습니다. 입력을 유지했습니다. 연결과 초안 상태를 확인한 뒤 다시 시도해 주세요.'
		});
	}
	redirect(303, deleting ? '/drafts' : '/drafts?open=' + values.id);
}

async function publishForm(form, batch = false) {
	const id = form.get('id')?.toString() || '';
	const version = form.get('version')?.toString() || '';
	if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
		return fail(400, { message: '올바른 초안을 선택해 주세요.' });
	const changed = () =>
		fail(409, {
			id,
			refreshRequired: true,
			message: '초안이 변경되었거나 이미 처리되었습니다. 최신 내용을 다시 확인한 뒤 게시해 주세요.'
		});
	let result;
	try {
		const sql = db();
		const [draft] =
			await sql`SELECT d.*, (to_jsonb(d) - 'id')::text AS snapshot FROM drafts d WHERE id=${id}`;
		if (!draft) return fail(404, { id, message: '초안을 찾을 수 없습니다.' });
		if (batch && draft.status === 'published' && draft.governance?.published?.version === version)
			return {
				id,
				title: draft.title,
				slug: draft.governance.published.slug,
				alreadyPublished: true,
				semanticSkipped: draft.governance.semantic?.skipped === true
			};
		if (draft.status === 'published') return changed();
		if (!/^[a-f0-9]{64}$/.test(version))
			return fail(400, {
				id,
				refreshRequired: true,
				message: '검토한 초안 버전을 확인할 수 없습니다. 최신 내용을 다시 열어 주세요.'
			});
		if (version !== reviewVersion(draft.snapshot)) return changed();
		if (batch && batchReviewReason(draft))
			return fail(400, { id, message: batchReviewReason(draft) });
		if (!canReplaceMerge(form, draft)) return fail(400, { id, message: replaceMergeMessage });
		if (
			form.has('content') &&
			(form.get('title')?.toString().trim() !== draft.title ||
				form.get('content')?.toString().replace(/\r\n/g, '\n') !==
					draft.content.replace(/\r\n/g, '\n') ||
				form.get('editor')?.toString().trim() !== draft.editor_handle ||
				JSON.stringify(parseAliases(form.get('aliases')?.toString() || '')) !==
					JSON.stringify(draft.aliases))
		)
			return fail(400, { id, message: '작성 중인 수정 내용을 먼저 저장한 뒤 게시해 주세요.' });
		if (
			!draft.title.trim() ||
			!draft.content.trim() ||
			!validHandle(draft.editor_handle) ||
			slugify(draft.slug) !== draft.slug ||
			!/[\p{L}\p{N}]/u.test(draft.slug)
		)
			return fail(400, {
				id,
				message: '제목, 본문, 주소 및 검토자 이름을 확인하고 초안을 다시 저장해 주세요.'
			});
		const governance = await inspectDocumentContent(draft);
		if (!governance.passed) {
			const rows = await sql`UPDATE drafts d SET status='blocked',
					governance=${JSON.stringify({ ...draft.governance, ...governance })}::jsonb,updated_at=NOW()
					WHERE id=${id} AND status <> 'published' AND (to_jsonb(d) - 'id')=${draft.snapshot}::jsonb
					RETURNING id`;
			if (!rows.length) return changed();
			return fail(governance.semantic.unavailable ? 503 : 400, {
				id,
				governance,
				message: governance.semantic.unavailable
					? '콘텐츠 보호 검사를 완료하지 못해 게시하지 않았습니다. 잠시 후 다시 저장해 주세요.'
					: '콘텐츠 보호 검사로 게시가 차단되었습니다. 표시된 내용을 확인해 주세요.'
			});
		}
		const aliases = publicationAliases(draft);
		if (!aliases)
			return fail(400, {
				id,
				message: '주소로 사용할 수 없는 별칭이 있습니다. 별칭을 수정한 뒤 다시 저장해 주세요.'
			});
		result = await publishDraft(sql, draft, governance, aliases);
		if (result.status === 'changed') return changed();
		if (result.status === 'conflict')
			return fail(409, {
				id,
				refreshRequired: true,
				message: publicationConflictMessage
			});
		return {
			id,
			title: draft.title,
			slug: result.slug,
			semanticSkipped: governance.semantic.skipped === true
		};
	} catch (error) {
		if (error.code === '23505')
			return fail(409, {
				id,
				message: '같은 제목·주소·별칭이 먼저 사용되었습니다. 초안을 수정한 뒤 다시 시도해 주세요.'
			});
		return fail(503, {
			id,
			message:
				'게시를 완료하지 못했습니다. 초안은 보존되어 있으니 잠시 후 상태를 확인하고 다시 시도해 주세요.'
		});
	}
}

async function publishBatch({ request }) {
	const form = await request.formData();
	const selection = form.getAll('draft').map(String);
	const entries = selection.map((token) => token.split(':'));
	if (
		form.get('confirmPublish') !== 'yes' ||
		!entries.length ||
		entries.length > batchReviewLimit ||
		entries.some(
			([id, version, extra]) =>
				!validDraftId(id) || !validDraftVersion(version || '') || extra !== undefined
		) ||
		new Set(entries.map(([id]) => id)).size !== entries.length
	)
		return fail(400, {
			action: 'publishBatch',
			selection: selection.slice(0, batchReviewLimit),
			message: `검토한 초안을 1~${batchReviewLimit}개 선택하고 선택 게시 버튼을 눌러 주세요.`
		});
	const results = new Array(entries.length);
	let next = 0;
	// Bound AI concurrency. Each item uses the existing independent publication transaction.
	await Promise.all(
		Array.from({ length: Math.min(4, entries.length) }, async () => {
			while (next < entries.length) {
				const index = next++;
				const [id, version] = entries[index];
				const fields = new FormData();
				fields.set('id', id);
				fields.set('version', version);
				const result = await publishForm(fields, true);
				results[index] = result.status
					? {
							id,
							outcome: 'failed',
							status: result.status,
							message: result.data.message,
							refreshRequired: result.data.refreshRequired === true
						}
					: { ...result, outcome: result.alreadyPublished ? 'alreadyPublished' : 'published' };
			}
		})
	);
	return { action: 'publishBatch', selection, results };
}

async function deleteBatch({ request }) {
	const form = await request.formData();
	const selection = form.getAll('draft').map(String);
	const entries = selection.map((token) => token.split(':'));
	const feedback = { action: 'deleteBatch', selection: selection.slice(0, batchDeleteLimit) };
	if (
		form.get('confirmDelete') !== 'yes' ||
		!entries.length ||
		entries.length > batchDeleteLimit ||
		entries.some(
			([id, version, extra]) =>
				!validDraftId(id) || !validDraftVersion(version || '') || extra !== undefined
		) ||
		new Set(entries.map(([id]) => id)).size !== entries.length
	)
		return fail(400, {
			...feedback,
			message: `삭제할 초안을 1~${batchDeleteLimit}개 선택하고 영구 삭제 확인 항목을 선택해 주세요.`
		});
	const changed = () =>
		fail(409, {
			...feedback,
			message:
				'선택한 초안 중 변경되었거나 이미 게시·삭제된 항목이 있습니다. 이번 요청에서는 아무 초안도 삭제하지 않았습니다. 목록을 새로 확인한 뒤 다시 선택해 주세요.'
		});
	try {
		const sql = db();
		const rows = await sql`SELECT d.*, (to_jsonb(d)-'id')::text AS snapshot FROM drafts d
			WHERE id IN (SELECT value::bigint FROM jsonb_array_elements_text(${JSON.stringify(entries.map(([id]) => id))}::jsonb))`;
		const byId = new Map(rows.map((draft) => [String(draft.id), draft]));
		const drafts = entries.map(([id]) => byId.get(id));
		if (
			drafts.some(
				(draft, index) =>
					!draft ||
					draft.status === 'published' ||
					reviewVersion(draft.snapshot) !== entries[index][1]
			)
		)
			return changed();
		if (!(await deleteDraftBatch(sql, drafts))) return changed();
		return { ...feedback, deleted: drafts.map(({ id, title }) => ({ id: String(id), title })) };
	} catch {
		return fail(503, {
			...feedback,
			message:
				'삭제 결과를 확인하지 못했습니다. 선택을 유지했습니다. 목록을 새로 확인한 뒤 다시 시도해 주세요.'
		});
	}
}

export const actions = {
	deleteBatch,
	publishBatch,
	applyMerge: applyMergeAction,
	generateMerge: (event) => mergeAction(event),
	discardMerge: (event) => mergeAction(event, true),
	update: (event) => editDraft(event),
	delete: (event) => editDraft(event, true),
	publish: async (event) => {
		const form = await event.request.formData();
		const values = submittedValues(form, 'publish');
		const result = await publishForm(form);
		if (result.status) return fail(result.status, { ...values, ...result.data });
		redirect(303, `/wiki/${encodeURIComponent(result.slug)}`);
	}
};
