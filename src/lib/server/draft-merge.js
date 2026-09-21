import { createHash, randomUUID } from 'node:crypto';
import { diffLines } from 'diff';
import { mergeCandidates, validMergeResult } from '../merge.js';
import { validDraftId, validDraftVersion } from './draft-write.js';
import { reviewVersion } from './draft-publication.js';

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

export async function listMergeTargets(sql, draft) {
	const rows = await sql`SELECT d.id,d.title,d.slug,
		jsonb_build_object('document',to_jsonb(d),'aliases',a.aliases)::text AS snapshot,a.aliases
		FROM documents d CROSS JOIN LATERAL (
			SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) AS aliases
			FROM redirects r WHERE r.document_id=d.id
		) a WHERE d.deleted_at IS NULL ORDER BY d.title,d.id`;
	return mergeCandidates(
		draft,
		rows.map(({ snapshot, aliases, ...row }) => ({
			...row,
			id: String(row.id),
			version: reviewVersion(snapshot),
			aliases: aliases.flatMap((alias) => [alias.alias_title, alias.alias_slug])
		}))
	);
}

export function createProposal(draft, target, generated) {
	return {
		schemaVersion: 1,
		id: randomUUID(),
		generatedAt: new Date().toISOString(),
		model: generated.model,
		draftFingerprint: draftFingerprint(draft),
		targetId: String(target.document.id),
		targetTitle: target.document.title,
		targetSlug: target.document.slug,
		targetVersion: target.updatedVersion,
		targetFingerprint: target.version,
		originalContent: target.document.content,
		...generated.result
	};
}

export function validMergeProposal(proposal) {
	return (
		!!proposal &&
		proposal.schemaVersion === 1 &&
		typeof proposal.id === 'string' &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(proposal.id) &&
		validDraftId(proposal.targetId) &&
		typeof proposal.targetVersion === 'string' &&
		validDraftVersion(proposal.targetFingerprint) &&
		typeof proposal.originalContent === 'string' &&
		proposal.originalContent.length <= 200000 &&
		typeof proposal.targetTitle === 'string' &&
		typeof proposal.targetSlug === 'string' &&
		validMergeResult({
			content: proposal.content,
			summary: proposal.summary,
			conflicts: proposal.conflicts
		})
	);
}

export function reviewProposal(draft, targets) {
	const proposal = draft.governance?.merge;
	if (!proposal) return null;
	if (!validMergeProposal(proposal)) return { invalid: true, stale: true };
	const target = targets.find((target) => target.id === proposal.targetId);
	const stale =
		!target ||
		target.version !== proposal.targetFingerprint ||
		draftFingerprint(draft) !== proposal.draftFingerprint;
	return {
		...proposal,
		stale,
		diff:
			diffLines(proposal.originalContent, proposal.content, {
				timeout: 100,
				maxEditLength: 10000
			}) || null
	};
}

// AI runs outside locks. Lock in the same order as publication, then re-read exact
// snapshots so edits, alias changes, trash/restore and competing proposals win safely.
export async function saveProposal(sql, draft, target, proposal) {
	const governance = { ...draft.governance };
	if (proposal) governance.merge = proposal;
	else delete governance.merge;
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`,
			tx`SELECT id FROM drafts WHERE id=${draft.id} FOR UPDATE`,
			tx`WITH target_state AS MATERIALIZED (
			SELECT jsonb_build_object('document',to_jsonb(d),'aliases',
				COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM redirects r WHERE r.document_id=d.id),'[]'::jsonb)) AS snapshot
			FROM documents d WHERE id=${target?.document.id || null}::bigint AND deleted_at IS NULL
		), eligible AS MATERIALIZED (
			SELECT id FROM drafts d WHERE id=${draft.id} AND status<>'published'
				AND (to_jsonb(d)-'id')=${draft.snapshot}::jsonb
				AND (${target?.document.id || null}::bigint IS NULL OR EXISTS (
					SELECT 1 FROM target_state WHERE snapshot=${target?.snapshot || null}::jsonb
				))
		), changed AS (
			UPDATE drafts SET governance=${JSON.stringify(governance)}::jsonb,updated_at=NOW()
			WHERE id IN (SELECT id FROM eligible) RETURNING id
		)
		SELECT EXISTS(SELECT 1 FROM changed) AS changed,
			1 / CASE WHEN (SELECT count(*) FROM eligible)=(SELECT count(*) FROM changed) THEN 1 ELSE 0 END AS atomic_guard`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return results.at(-1)[0].changed;
}
