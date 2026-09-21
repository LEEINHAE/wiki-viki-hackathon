import { slugify } from '../knowledge.js';
import { draftFingerprint, validMergeProposal } from './draft-merge.js';
import { normalizeMergeText } from '../merge-history.js';

export function proposalMatches(draft, target, proposalId) {
	const proposal = draft.governance?.merge;
	return (
		!!target &&
		validMergeProposal(proposal) &&
		proposal.id === proposalId &&
		proposal.targetId === String(target.document.id) &&
		proposal.targetVersion === target.updatedVersion &&
		proposal.targetFingerprint === target.version &&
		proposal.targetTitle === target.document.title &&
		proposal.targetSlug === target.document.slug &&
		proposal.originalContent === target.document.content &&
		proposal.draftFingerprint === draftFingerprint(draft)
	);
}

export function mergeAliases(draft, target) {
	if (!Array.isArray(draft.aliases) || !draft.aliases.every((alias) => typeof alias === 'string'))
		return null;
	const aliases = new Map();
	for (const name of [draft.title, ...draft.aliases]) {
		const title = name.trim();
		if (!title) continue;
		const slug = slugify(title);
		if (!/[\p{L}\p{N}]/u.test(slug)) return null;
		if (slug !== target.document.slug && !aliases.has(slug))
			aliases.set(slug, { alias_slug: slug, alias_title: title });
	}
	return [...aliases.values()];
}

export function hasMergeEdits(form, draft) {
	const proposal = draft.governance?.merge;
	if (!proposal || typeof proposal.content !== 'string') return form.has('finalContent');
	return (
		(form.has('finalContent') &&
			normalizeMergeText(form.get('finalContent').toString()) !==
				normalizeMergeText(proposal.content)) ||
		(form.has('mergeEditor') && form.get('mergeEditor').toString().trim() !== draft.editor_handle)
	);
}

export async function applyMerge(
	sql,
	{ draft, target, content, editor, aliases, governance, summary }
) {
	const proposal = draft.governance.merge;
	const savedGovernance = {
		...draft.governance,
		...governance,
		mergedInto: {
			id: String(target.document.id),
			title: target.document.title,
			slug: target.document.slug,
			proposalId: proposal.id,
			reviewedVersion: draft.version
		}
	};
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`,
			tx`SELECT id FROM drafts WHERE id=${draft.id} FOR UPDATE`,
			tx`WITH target_state AS MATERIALIZED (
			SELECT jsonb_build_object('document',to_jsonb(d),'aliases',
				COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM redirects r WHERE r.document_id=d.id),'[]'::jsonb)) AS snapshot
			FROM documents d WHERE id=${target.document.id} AND deleted_at IS NULL AND updated_at::text=${proposal.targetVersion}
		), eligible AS MATERIALIZED (
			SELECT id FROM drafts d WHERE id=${draft.id} AND status<>'published'
				AND (to_jsonb(d)-'id')=${draft.snapshot}::jsonb
				AND governance->'merge'->>'id'=${proposal.id}
				AND governance->'merge'->>'draftFingerprint'=${draftFingerprint(draft)}
				AND EXISTS (SELECT 1 FROM target_state WHERE snapshot=${target.snapshot}::jsonb)
		), alias_input AS MATERIALIZED (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(aliases)}::jsonb) AS a(alias_slug text,alias_title text)
		), available_aliases AS MATERIALIZED (
			SELECT a.* FROM alias_input a
			WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.slug=a.alias_slug OR d.title=a.alias_title)
				AND NOT EXISTS (SELECT 1 FROM redirects r WHERE r.alias_slug=a.alias_slug OR r.alias_title=a.alias_title)
		), claimed AS (
			UPDATE drafts SET status='published',governance=${JSON.stringify(savedGovernance)}::jsonb,updated_at=NOW()
			WHERE id IN (SELECT id FROM eligible) RETURNING id
		), saved AS (
			UPDATE documents SET content=${content},editor_handle=${editor},updated_at=NOW()
			WHERE id=${target.document.id} AND EXISTS (SELECT 1 FROM claimed) RETURNING *
		), revision AS (
			INSERT INTO revisions(document_id,content,editor_handle,summary)
			SELECT id,content,editor_handle,${summary} FROM saved RETURNING id
		), inserted_aliases AS (
			INSERT INTO redirects(alias_slug,alias_title,document_id)
			SELECT a.alias_slug,a.alias_title,d.id FROM available_aliases a CROSS JOIN saved d RETURNING id
		)
		SELECT CASE WHEN EXISTS(SELECT 1 FROM saved) THEN 'merged' ELSE 'changed' END AS status,
			(SELECT slug FROM saved) AS slug,
			1 / CASE WHEN (SELECT count(*) FROM eligible)=(SELECT count(*) FROM claimed)
				AND (SELECT count(*) FROM claimed)=(SELECT count(*) FROM saved)
				AND (SELECT count(*) FROM saved)=(SELECT count(*) FROM revision)
				AND (SELECT count(*) FROM inserted_aliases)=(SELECT count(*) FROM available_aliases)*(SELECT count(*) FROM saved)
				THEN 1 ELSE 0 END AS atomic_guard`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return results.at(-1)[0];
}
