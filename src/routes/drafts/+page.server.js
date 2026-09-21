import { randomUUID } from 'node:crypto';
import { fail, redirect } from '@sveltejs/kit';
import { diffLines } from 'diff';
import { db } from '$lib/server/db.js';
import { regexGovernance, validHandle } from '$lib/server/governance.js';
import { semanticGovernance, mergeDocuments } from '$lib/server/openai.js';
import { slugify, renderWiki } from '$lib/server/wiki.js';
import { matchingDocuments } from '$lib/merging.js';
import {
	draftFingerprint,
	publishNewDraft,
	applyMergedDraft
} from '$lib/server/draft-publishing.js';

const staleMessage =
	'초안 또는 기존 문서가 변경되었습니다. 새로고침한 뒤 통합안을 다시 생성해 주세요.';

async function readDraft(sql, form) {
	const id = Number(form.get('id'));
	if (!Number.isSafeInteger(id) || id <= 0) return null;
	const [draft] =
		await sql`SELECT *,updated_at::text AS version FROM drafts WHERE id=${id} AND status <> 'published'`;
	return draft;
}

function aiFailure(error) {
	if (error.message === 'AI_KEY_MISSING')
		return fail(503, { message: 'AI 연결이 설정되지 않았습니다.' });
	if (error.status === 429)
		return fail(503, { message: 'AI 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' });
	return fail(502, {
		message: 'AI 검토를 완료하지 못했습니다. 저장된 내용은 그대로이며 다시 시도할 수 있습니다.'
	});
}

async function inspectContent(content) {
	const regex = regexGovernance(content);
	const semantic = regex.passed
		? await semanticGovernance(content)
		: { passed: false, reasons: [] };
	return { passed: regex.passed && semantic.passed === true, regex, semantic };
}

export async function load({ url }) {
	try {
		const sql = db();
		const [drafts, documents, aliases] = await Promise.all([
			sql`SELECT id,title,slug,aliases,status,source_name,editor_handle,created_at FROM drafts WHERE status <> 'published' ORDER BY created_at DESC,id DESC`,
			sql`SELECT id,title,slug,updated_at::text AS version FROM documents ORDER BY title`,
			sql`SELECT alias_slug,document_id FROM redirects`
		]);
		const requested = Number(url.searchParams.get('open'));
		const selected =
			Number.isSafeInteger(requested) && requested > 0
				? (
						await sql`SELECT *,updated_at::text AS version FROM drafts WHERE id=${requested} AND status <> 'published'`
					)[0] || null
				: null;
		const proposal = selected?.governance?.merge || null;
		const target =
			proposal && documents.find((doc) => String(doc.id) === String(proposal.target.id));
		return {
			drafts,
			selected,
			documents,
			matches: selected ? matchingDocuments(selected, documents, aliases) : [],
			duplicate: selected
				? documents.some((doc) => doc.slug === selected.slug || doc.title === selected.title) ||
					aliases.some((alias) => alias.alias_slug === selected.slug)
				: false,
			proposal,
			mergeStale: Boolean(
				proposal &&
				(!target ||
					target.version !== proposal.target.version ||
					proposal.draftFingerprint !== draftFingerprint(selected))
			),
			mergeDiff: proposal
				? diffLines(proposal.baseContent, proposal.content, { timeout: 1000 }) || []
				: [],
			previewHtml: selected ? await renderWiki(selected.content, drafts) : '',
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
		return { drafts: [], documents: [], selected: null, databaseError: true };
	}
}

export const actions = {
	update: async ({ request }) => {
		const form = await request.formData();
		const sql = db();
		const draft = await readDraft(sql, form);
		if (!draft) return fail(404, { message: '초안을 찾을 수 없습니다.' });
		if (form.get('version') !== draft.version) return fail(409, { message: staleMessage });
		const title = form.get('title')?.toString().trim();
		const content = form.get('content')?.toString().trim();
		const editor = form.get('editor')?.toString();
		if (!title || !slugify(title) || !content || content.length > 200000 || !validHandle(editor))
			return fail(400, {
				message: '제목, 내용(20만 자 이하) 및 올바른 익명 사용자 이름을 입력해 주세요.'
			});
		let governance;
		try {
			governance = await inspectContent(title + '\n' + content);
		} catch (error) {
			return aiFailure(error);
		}
		const changed =
			await sql`UPDATE drafts SET title=${title},slug=${slugify(title)},content=${content},editor_handle=${editor},governance=${JSON.stringify(governance)}::jsonb,status=${governance.passed ? 'review' : 'blocked'},updated_at=NOW() WHERE id=${draft.id} AND status <> 'published' AND updated_at::text=${draft.version} RETURNING id`;
		if (!changed.length) return fail(409, { message: staleMessage });
		redirect(303, `/drafts?open=${draft.id}`);
	},
	merge: async ({ request }) => {
		const form = await request.formData();
		const sql = db();
		const draft = await readDraft(sql, form);
		if (!draft) return fail(404, { message: '초안을 찾을 수 없습니다.' });
		if (form.get('version') !== draft.version) return fail(409, { message: staleMessage });
		const targetId = Number(form.get('target'));
		if (!Number.isSafeInteger(targetId) || targetId <= 0)
			return fail(400, { message: '통합할 기존 문서를 선택해 주세요.' });
		const [target] =
			await sql`SELECT *,updated_at::text AS version FROM documents WHERE id=${targetId}`;
		if (!target) return fail(404, { message: '기존 문서를 찾을 수 없습니다.' });
		const input = target.title + '\n' + target.content + '\n' + draft.title + '\n' + draft.content;
		if (input.length > 200000)
			return fail(400, {
				message: '두 문서의 합계가 20만 자를 넘습니다. 초안을 나누어 통합해 주세요.'
			});
		if (!regexGovernance(input).passed)
			return fail(400, {
				message: '콘텐츠 보호 검사로 통합할 수 없습니다. 문서 내용을 확인해 주세요.'
			});
		let merged;
		try {
			merged = await mergeDocuments(target, draft);
		} catch (error) {
			return aiFailure(error);
		}
		if (!regexGovernance(merged.content).passed)
			return fail(400, { message: '생성된 통합안이 콘텐츠 보호 검사를 통과하지 못했습니다.' });
		const proposal = {
			...merged,
			id: randomUUID(),
			target: { id: target.id, title: target.title, slug: target.slug, version: target.version },
			draftFingerprint: draftFingerprint(draft),
			baseContent: target.content
		};
		const changed =
			await sql`UPDATE drafts SET governance=governance || ${JSON.stringify({ merge: proposal })}::jsonb,updated_at=NOW() WHERE id=${draft.id} AND status <> 'published' AND updated_at::text=${draft.version} RETURNING id`;
		if (!changed.length) return fail(409, { message: staleMessage });
		redirect(303, `/drafts?open=${draft.id}`);
	},
	applyMerge: async ({ request }) => {
		const form = await request.formData();
		const sql = db();
		const draft = await readDraft(sql, form);
		const proposal = draft?.governance?.merge;
		if (
			!draft ||
			!proposal ||
			form.get('proposal') !== proposal.id ||
			form.get('version') !== draft.version ||
			proposal.draftFingerprint !== draftFingerprint(draft)
		)
			return fail(409, { message: staleMessage });
		const content = form.get('content')?.toString().trim();
		const editor = form.get('editor')?.toString();
		if (
			!content ||
			content.length > 200000 ||
			!validHandle(editor) ||
			form.get('reviewed') !== 'yes'
		)
			return fail(400, {
				message: '통합 본문과 검토자 이름을 입력하고, 상충 내용 검토에 체크해 주세요.'
			});
		let governance;
		try {
			governance = await inspectContent(proposal.target.title + '\n' + content);
		} catch (error) {
			return aiFailure(error);
		}
		if (!governance.passed)
			return fail(400, {
				message: `콘텐츠 보호 검사로 통합이 차단되었습니다. ${[...governance.regex.reasons, ...governance.semantic.reasons].join(', ')}`
			});
		const document = await applyMergedDraft(sql, draft, proposal, content, editor, governance);
		if (!document) return fail(409, { message: staleMessage });
		redirect(303, `/wiki/${encodeURIComponent(document.slug)}`);
	},
	discardMerge: async ({ request }) => {
		const form = await request.formData();
		const sql = db();
		const draft = await readDraft(sql, form);
		if (!draft || draft.version !== form.get('version'))
			return fail(409, { message: staleMessage });
		const changed =
			await sql`UPDATE drafts SET governance=governance - 'merge',updated_at=NOW() WHERE id=${draft.id} AND status <> 'published' AND updated_at::text=${draft.version} RETURNING id`;
		if (!changed.length) return fail(409, { message: staleMessage });
		redirect(303, `/drafts?open=${draft.id}`);
	},
	publish: async ({ request }) => {
		const form = await request.formData();
		const sql = db();
		const draft = await readDraft(sql, form);
		if (!draft) return fail(404, { message: '초안을 찾을 수 없습니다.' });
		if (form.get('version') !== draft.version) return fail(409, { message: staleMessage });
		const existing =
			await sql`SELECT id FROM documents WHERE slug=${draft.slug} OR title=${draft.title} UNION ALL SELECT document_id AS id FROM redirects WHERE alias_slug=${draft.slug} LIMIT 1`;
		if (existing.length)
			return fail(409, {
				message:
					'같은 이름의 기존 문서가 있습니다. AI 통합을 사용하거나 제목을 변경한 뒤 새 문서로 게시해 주세요.'
			});
		let governance;
		try {
			governance = await inspectContent(draft.title + '\n' + draft.content);
		} catch (error) {
			return aiFailure(error);
		}
		if (!governance.passed) {
			await sql`UPDATE drafts SET status='blocked',governance=${JSON.stringify(governance)}::jsonb,updated_at=NOW() WHERE id=${draft.id} AND status <> 'published' AND updated_at::text=${draft.version}`;
			return fail(400, {
				message: '콘텐츠 보호 검사로 게시가 차단되었습니다. 표시된 내용을 확인해 주세요.'
			});
		}
		const document = await publishNewDraft(sql, draft, governance);
		if (!document)
			return fail(409, {
				message:
					'초안이 변경되었거나 같은 이름의 문서가 게시되었습니다. 새로고침 후 다시 확인해 주세요.'
			});
		redirect(303, `/wiki/${encodeURIComponent(document.slug)}`);
	},
	delete: async ({ request }) => {
		const form = await request.formData();
		const sql = db();
		const draft = await readDraft(sql, form);
		if (!draft || form.get('version') !== draft.version)
			return fail(409, { message: staleMessage });
		const deleted =
			await sql`DELETE FROM drafts WHERE id=${draft.id} AND status <> 'published' AND updated_at::text=${draft.version} RETURNING id`;
		if (!deleted.length) return fail(409, { message: staleMessage });
		redirect(303, '/drafts');
	}
};
