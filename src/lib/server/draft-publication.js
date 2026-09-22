import { createHash } from 'node:crypto';
import { slugify } from '../knowledge.js';

export function reviewVersion(snapshot) {
	return createHash('sha256').update(snapshot).digest('hex');
}

export function publicationAliases(draft) {
	const aliases = new Map();
	for (const value of draft.aliases) {
		const title = value.trim();
		if (!title) continue;
		const slug = slugify(title);
		if (!/[\p{L}\p{N}]/u.test(slug)) return null;
		if (slug !== draft.slug && !aliases.has(slug))
			aliases.set(slug, { alias_slug: slug, alias_title: title });
	}
	return [...aliases.values()];
}

export async function publishDraft(sql, draft, governance, aliases) {
	const routes = [draft.slug, ...aliases.map((alias) => alias.alias_slug)];
	const names = [draft.title, ...aliases.map((alias) => alias.alias_title)];
	const savedGovernance = {
		...draft.governance,
		...governance,
		published: { slug: draft.slug, version: reviewVersion(draft.snapshot) }
	};
	delete savedGovernance.publication;
	const conflictGovernance = {
		...draft.governance,
		...governance,
		publication: { code: 'conflict' }
	};
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			// Use a separate statement so the following READ COMMITTED snapshot sees
			// writers that finished while waiting. No AI request runs under these locks.
			tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`,
			tx`SELECT id FROM drafts WHERE id=${draft.id} FOR UPDATE`,
			tx`
				WITH alias_input AS MATERIALIZED (
					SELECT * FROM jsonb_to_recordset(${JSON.stringify(aliases)}::jsonb)
					AS a(alias_slug text, alias_title text)
				), conflicts AS MATERIALIZED (
					SELECT id FROM documents WHERE title=ANY(${names}::text[]) OR slug=ANY(${routes}::text[])
					UNION ALL SELECT document_id FROM redirects
						WHERE alias_slug=ANY(${routes}::text[]) OR alias_title=ANY(${names}::text[])
				), eligible AS MATERIALIZED (
					SELECT id FROM drafts d WHERE id=${draft.id} AND status<>'published'
						AND (to_jsonb(d)-'id')=${draft.snapshot}::jsonb
				), review_required AS (
					UPDATE drafts SET status='blocked', governance=${JSON.stringify(conflictGovernance)}::jsonb,
						updated_at=NOW()
					WHERE id IN (SELECT id FROM eligible) AND EXISTS (SELECT 1 FROM conflicts)
					RETURNING id
				), claimed AS (
					UPDATE drafts d SET status='published', governance=${JSON.stringify(savedGovernance)}::jsonb,
						updated_at=NOW()
					WHERE id IN (SELECT id FROM eligible)
						AND NOT EXISTS (SELECT 1 FROM conflicts)
					RETURNING d.*
				), created AS (
					INSERT INTO documents (slug,title,content,editor_handle)
					SELECT slug,title,content,editor_handle FROM claimed RETURNING *
				), revision AS (
					INSERT INTO revisions (document_id,content,editor_handle,summary)
					SELECT id,content,editor_handle,${`초안 ${draft.id}에서 게시`} FROM created RETURNING id
				), inserted_aliases AS (
					INSERT INTO redirects (alias_slug,alias_title,document_id)
					SELECT a.alias_slug,a.alias_title,c.id FROM alias_input a CROSS JOIN created c RETURNING id
				)
				SELECT CASE WHEN EXISTS (SELECT 1 FROM created) THEN 'published'
					WHEN EXISTS (SELECT 1 FROM review_required) THEN 'conflict' ELSE 'changed' END AS status,
					(SELECT slug FROM created) AS slug,
					-- A trigger that silently skips an INSERT must also roll back the claim.
					1 / CASE WHEN (SELECT count(*) FROM claimed)=(SELECT count(*) FROM created)
						AND (SELECT count(*) FROM eligible)=(SELECT count(*) FROM claimed)+(SELECT count(*) FROM review_required)
						AND (SELECT count(*) FROM revision)=(SELECT count(*) FROM created)
						AND (SELECT count(*) FROM inserted_aliases)=
							(SELECT count(*) FROM created) * ${aliases.length}
						THEN 1 ELSE 0 END AS atomic_guard
			`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return results.at(-1)[0];
}
