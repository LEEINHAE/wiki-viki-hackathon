import { json } from '@sveltejs/kit';
import { renderWiki, buildToc } from '$lib/server/wiki.js';
import { getEditableDocument, editableAliases } from '$lib/server/document-write.js';
import { validDocumentId } from '$lib/server/document-trash.js';
import { slugify } from '$lib/knowledge.js';
import { db } from '$lib/server/db.js';
import { validDraftId, getDraft } from '$lib/server/draft-write.js';
import { publicationAliases } from '$lib/server/draft-publication.js';
import { mergeAliases, proposalMatches } from '$lib/server/merge-application.js';

const headers = { 'cache-control': 'no-store' };

export async function POST({ request }) {
	let input;
	try {
		input = await request.json();
	} catch {
		return json({ message: '미리보기 내용을 확인해 주세요.' }, { status: 400, headers });
	}
	if (typeof input?.content !== 'string')
		return json({ message: '미리보기 내용을 확인해 주세요.' }, { status: 400, headers });
	const document = input.document;
	const draft = input.draft;
	const anchorPrefix = input.anchorPrefix ?? '';
	if (
		(input.showImages !== undefined && typeof input.showImages !== 'boolean') ||
		typeof anchorPrefix !== 'string' ||
		!/^[-a-zA-Z0-9_]{0,100}$/.test(anchorPrefix) ||
		(draft !== undefined &&
			(document !== undefined ||
				!draft ||
				typeof draft.id !== 'string' ||
				!validDraftId(draft.id) ||
				!['edit', 'merge'].includes(draft.mode) ||
				(draft.mode === 'edit' &&
					(typeof draft.title !== 'string' || typeof draft.aliases !== 'string')) ||
				(draft.mode === 'merge' && typeof draft.proposalId !== 'string')))
	)
		return json({ message: '미리보기 문서 정보를 확인해 주세요.' }, { status: 400, headers });
	if (
		document !== undefined &&
		(!document ||
			typeof document.id !== 'string' ||
			(document.id && !validDocumentId(document.id)) ||
			typeof document.title !== 'string' ||
			typeof document.aliases !== 'string' ||
			typeof document.aliasesFormat !== 'string')
	)
		return json({ message: '미리보기 문서 정보를 확인해 주세요.' }, { status: 400, headers });
	if (!input.content.trim()) return json({ html: '', toc: [] }, { headers });
	try {
		let linkChanges = {};
		let sourceSlug = '';
		if (draft?.mode === 'edit') {
			sourceSlug = slugify(draft.title);
			const aliases = publicationAliases({
				slug: sourceSlug,
				aliases: draft.aliases.split(/\r?\n/)
			});
			if (!aliases)
				return json({ message: '미리보기 별칭을 확인해 주세요.' }, { status: 400, headers });
			linkChanges = { added: [sourceSlug, ...aliases.map((alias) => alias.alias_slug)] };
		} else if (draft?.mode === 'merge') {
			const sql = db();
			const current = await getDraft(sql, draft.id);
			const targetId = current?.governance?.merge?.targetId;
			const target = validDocumentId(targetId || '')
				? await getEditableDocument('', targetId)
				: null;
			if (
				!current ||
				current.status === 'published' ||
				!proposalMatches(current, target, draft.proposalId)
			)
				return json(
					{ message: '통합 대상의 현재 상태를 확인해 주세요. 입력 내용은 유지됩니다.' },
					{ status: 409, headers }
				);
			const aliases = mergeAliases(current, target);
			if (!aliases) throw new Error('Invalid preview aliases');
			// Match applyMerge's available-alias rule, including URLs reserved in trash.
			const available =
				await sql`SELECT a.alias_slug FROM jsonb_to_recordset(${JSON.stringify(aliases)}::jsonb) AS a(alias_slug text,alias_title text)
				WHERE NOT EXISTS(SELECT 1 FROM documents d WHERE d.slug=a.alias_slug OR d.title=a.alias_title)
				AND NOT EXISTS(SELECT 1 FROM redirects r WHERE r.alias_slug=a.alias_slug)`;
			sourceSlug = target.document.slug;
			linkChanges = { added: available.map((alias) => alias.alias_slug) };
		} else if (document) {
			const current = document.id ? await getEditableDocument('', document.id) : null;
			if (document.id && !current) throw new Error('Preview document unavailable');
			const slug = current?.document.slug || slugify(document.title);
			sourceSlug = slug;
			const aliases = editableAliases(
				document.aliases.split(document.aliasesFormat === 'lines' ? /\r?\n/ : ','),
				slug,
				current?.aliases
			);
			if (!aliases)
				return json({ message: '미리보기 별칭을 확인해 주세요.' }, { status: 400, headers });
			// Use the same own-alias/URL rules as saving, without approving the edit.
			linkChanges = {
				removed: current?.aliases.map((alias) => alias.alias_slug) || [],
				added: [slug, ...aliases.map((alias) => alias.alias_slug)]
			};
		}
		// Read-only rendering: never save an edit, approve content or call an AI service.
		return json(
			{
				html: await renderWiki(input.content, [], linkChanges, {
					sourceSlug,
					anchorPrefix,
					imageLinks: !!draft && input.showImages !== true
				}),
				toc: buildToc(input.content).map((item) => ({ ...item, id: anchorPrefix + item.id }))
			},
			{ headers }
		);
	} catch {
		return json(
			{ message: '미리보기를 불러오지 못했습니다. 입력 내용은 유지됩니다.' },
			{ status: 503, headers }
		);
	}
}
