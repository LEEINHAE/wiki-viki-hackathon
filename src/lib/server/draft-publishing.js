import { createHash } from 'node:crypto';
import { slugify } from '../knowledge.js';
import { mergeRevisionSummary } from '../merging.js';

export function draftFingerprint(draft) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				draft.title,
				draft.slug,
				draft.content,
				draft.aliases,
				draft.source_name,
				draft.editor_handle
			])
		)
		.digest('hex');
}

function aliasRows(draft, target) {
	return [...new Set([...(draft.aliases || []), ...(target ? [draft.title] : [])])]
		.map((title) => ({ title, slug: slugify(title) }))
		.filter((alias) => alias.slug && alias.slug !== (target?.slug || draft.slug));
}

export async function publishNewDraft(sql, draft, governance) {
	const [document] = await sql`
		WITH locked_draft AS (
			SELECT * FROM drafts WHERE id=${draft.id} AND status <> 'published' AND updated_at::text=${draft.version} FOR UPDATE
		), inserted AS (
			INSERT INTO documents (slug,title,content,editor_handle)
			SELECT slug,title,content,editor_handle FROM locked_draft
			WHERE NOT EXISTS (SELECT 1 FROM redirects WHERE alias_slug=${draft.slug})
			ON CONFLICT DO NOTHING RETURNING *
		), revision AS (
			INSERT INTO revisions (document_id,content,editor_handle,summary)
			SELECT id,content,editor_handle,${`초안 ${draft.id}에서 게시`} FROM inserted
		), completed AS (
			UPDATE drafts SET status='published',governance=${JSON.stringify(governance)}::jsonb,updated_at=NOW()
			FROM inserted WHERE drafts.id=${draft.id} RETURNING drafts.id
		), aliases AS (
			INSERT INTO redirects (alias_slug,alias_title,document_id)
			SELECT a.slug,a.title,d.id FROM inserted d CROSS JOIN jsonb_to_recordset(${JSON.stringify(aliasRows(draft))}::jsonb) AS a(slug text,title text)
			WHERE NOT EXISTS (SELECT 1 FROM documents WHERE slug=a.slug)
			ON CONFLICT (alias_slug) DO NOTHING
		) SELECT id,slug FROM inserted`;
	return document;
}

export async function applyMergedDraft(sql, draft, proposal, content, editor, governance) {
	if (proposal.draftFingerprint !== draftFingerprint(draft)) return null;
	const [document] = await sql`
		WITH locked_draft AS (
			SELECT id FROM drafts WHERE id=${draft.id} AND status <> 'published'
			AND updated_at::text=${draft.version} AND governance->'merge'->>'id'=${proposal.id} FOR UPDATE
		), locked_document AS (
			SELECT d.id FROM documents d,locked_draft WHERE d.id=${proposal.target.id}
			AND d.updated_at::text=${proposal.target.version} FOR UPDATE OF d
		), updated AS (
			UPDATE documents d SET content=${content},editor_handle=${editor},updated_at=NOW()
			FROM locked_document WHERE d.id=locked_document.id RETURNING d.*
		), revision AS (
			INSERT INTO revisions (document_id,content,editor_handle,summary)
			SELECT id,content,editor_handle,${mergeRevisionSummary(draft, proposal, content)} FROM updated
		), completed AS (
			UPDATE drafts SET status='published',governance=${JSON.stringify({ ...governance, mergedInto: proposal.target.id, merge: proposal })}::jsonb,updated_at=NOW()
			FROM updated WHERE drafts.id=${draft.id} RETURNING drafts.id
		), aliases AS (
			INSERT INTO redirects (alias_slug,alias_title,document_id)
			SELECT a.slug,a.title,d.id FROM updated d CROSS JOIN jsonb_to_recordset(${JSON.stringify(aliasRows(draft, proposal.target))}::jsonb) AS a(slug text,title text)
			WHERE NOT EXISTS (SELECT 1 FROM documents WHERE slug=a.slug)
			ON CONFLICT (alias_slug) DO NOTHING
		) SELECT id,slug FROM updated`;
	return document;
}
