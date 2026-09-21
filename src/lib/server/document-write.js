import { createHash } from 'node:crypto';
import { db } from './db.js';
import { slugify } from '../knowledge.js';

export async function getEditableDocument(slug, id = null, { includeDeleted = false } = {}) {
	const sql = db();
	const [row] = await sql`
		SELECT d.*, d.updated_at::text AS "updatedVersion", a.aliases,
			jsonb_build_object('document',to_jsonb(d),'aliases',a.aliases)::text AS snapshot
		FROM documents d
		CROSS JOIN LATERAL (
			SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) AS aliases
			FROM redirects r WHERE r.document_id=d.id
		) a
		WHERE (${includeDeleted}::boolean OR d.deleted_at IS NULL)
			AND (${includeDeleted}::boolean OR ${id}::bigint IS NOT NULL OR NOT EXISTS (
				SELECT 1 FROM documents reserved WHERE reserved.slug=${slug} AND reserved.deleted_at IS NOT NULL
			)) AND ((${id}::bigint IS NOT NULL AND d.id=${id}::bigint) OR (${id}::bigint IS NULL
			AND (d.slug=${slug} OR d.id IN (SELECT document_id FROM redirects WHERE alias_slug=${slug}))))
		ORDER BY (d.slug=${slug}) DESC LIMIT 1`;
	if (!row) return null;
	const { aliases, snapshot, updatedVersion, ...document } = row;
	return {
		document,
		aliases,
		updatedVersion,
		snapshot,
		version: createHash('sha256').update(snapshot).digest('hex')
	};
}

export function editableAliases(values, slug, existing = []) {
	const aliases = new Map();
	const retained = new Set();
	for (const value of values) {
		const title = value.trim();
		if (!title) continue;
		// Legacy aliases may have a stored URL that differs from today's slugify
		// result. An unchanged label must preserve that URL and the existing row.
		const original = existing.find(
			(alias) => alias.alias_title.trim() === title && !retained.has(alias.alias_slug)
		);
		const aliasSlug = original?.alias_slug ?? slugify(title);
		if (original) retained.add(aliasSlug);
		if (!original && !/[\p{L}\p{N}]/u.test(aliasSlug)) return null;
		if (aliasSlug === slug && !existing.some((alias) => alias.alias_slug === slug)) continue;
		if (!aliases.has(aliasSlug))
			aliases.set(aliasSlug, { alias_slug: aliasSlug, alias_title: title });
	}
	return [...aliases.values()];
}

// expected is the complete document/alias snapshot inspected before saving, or
// null for creation. Omitting it must never fall back to an unconditional upsert.
// A rollback also locks and rechecks its reviewed source revision in this transaction.
export async function saveDocument({
	title,
	content,
	editor,
	summary = '',
	expected,
	requestedSlug,
	sourceRevision = null,
	aliases
}) {
	if (expected === undefined || !Array.isArray(aliases))
		throw new Error('A reviewed document state is required.');
	const sql = db();
	const id = expected?.document.id || null;
	const slug = expected?.document.slug || slugify(title);
	// Old URLs need not match their labels. Reserve newly introduced names too,
	// while allowing unchanged legacy names without forcing a data cleanup.
	const existingNames = new Set(
		expected
			? [expected.document.title, ...expected.aliases.map((a) => a.alias_title)].map((name) =>
					name.trim()
				)
			: []
	);
	const newNames = [...new Set([title, ...aliases.map((a) => a.alias_title)])].filter(
		(name) => !existingNames.has(name.trim())
	);
	// Keeping the existing title introduces no derived URL. Changed/new titles
	// still need that check, even when the proposed title was an owned alias.
	const routes = [
		...new Set([
			slug,
			...(!expected || title.trim() !== expected.document.title.trim() ? [slugify(title)] : []),
			...aliases.map((a) => a.alias_slug)
		])
	];
	const results = await sql.transaction(
		(tx) => [
			tx`SET LOCAL lock_timeout = '10s'`,
			tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`,
			tx`
			WITH alias_input AS MATERIALIZED (
				SELECT * FROM jsonb_to_recordset(${JSON.stringify(aliases)}::jsonb) AS a(alias_slug text,alias_title text)
			), old_aliases AS MATERIALIZED (
				SELECT * FROM redirects WHERE document_id=${id}::bigint
			), current_state AS MATERIALIZED (
				SELECT jsonb_build_object('document',to_jsonb(d),'aliases',
					COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM old_aliases r),'[]'::jsonb)) AS snapshot
				FROM documents d WHERE id=${id}::bigint AND deleted_at IS NULL
			), reviewed_source AS MATERIALIZED (
				SELECT to_jsonb(r) AS snapshot FROM revisions r
				WHERE id=${sourceRevision?.id || null}::bigint AND document_id=${id}::bigint
				FOR SHARE OF r
			), eligible AS MATERIALIZED (
				SELECT 1 WHERE (${sourceRevision?.id || null}::bigint IS NULL OR EXISTS (
					SELECT 1 FROM reviewed_source WHERE snapshot=${sourceRevision?.snapshot || null}::jsonb
				)) AND ((${id}::bigint IS NOT NULL AND EXISTS (
					SELECT 1 FROM current_state WHERE snapshot=${expected?.snapshot || null}::jsonb
				)) OR (${id}::bigint IS NULL
					AND NOT EXISTS (SELECT 1 FROM documents WHERE slug=${requestedSlug})
					AND NOT EXISTS (SELECT 1 FROM redirects WHERE alias_slug=${requestedSlug})))
			), conflicts AS MATERIALIZED (
				SELECT id FROM documents WHERE id IS DISTINCT FROM ${id}::bigint
					AND (title=${title} OR title=ANY(${newNames}::text[]) OR slug=ANY(${routes}::text[]))
				UNION ALL SELECT document_id FROM redirects WHERE document_id IS DISTINCT FROM ${id}::bigint
					AND (alias_slug=ANY(${routes}::text[]) OR alias_title=ANY(${newNames}::text[]))
			), allowed AS MATERIALIZED (
				SELECT 1 FROM eligible WHERE NOT EXISTS (SELECT 1 FROM conflicts)
			), created AS (
				INSERT INTO documents (slug,title,content,editor_handle)
				SELECT ${slug},${title},${content},${editor} FROM allowed WHERE ${id}::bigint IS NULL RETURNING *
			), updated AS (
				UPDATE documents SET title=${title},content=${content},editor_handle=${editor},updated_at=NOW()
				WHERE id=${id}::bigint AND EXISTS (SELECT 1 FROM allowed) RETURNING *
			), saved AS MATERIALIZED (
				SELECT * FROM created UNION ALL SELECT * FROM updated
			), revision AS (
				INSERT INTO revisions (document_id,content,editor_handle,summary)
				SELECT id,content,editor_handle,${summary} FROM saved RETURNING id
			), removed AS (
				DELETE FROM redirects r USING saved d WHERE r.document_id=d.id
					AND NOT EXISTS (SELECT 1 FROM alias_input a WHERE a.alias_slug=r.alias_slug) RETURNING r.id
			), renamed AS (
				UPDATE redirects r SET alias_title=a.alias_title FROM alias_input a, saved d
				WHERE r.document_id=d.id AND r.alias_slug=a.alias_slug AND r.alias_title<>a.alias_title RETURNING r.id
			), inserted AS (
				INSERT INTO redirects (alias_slug,alias_title,document_id)
				SELECT a.alias_slug,a.alias_title,d.id FROM alias_input a CROSS JOIN saved d
				WHERE NOT EXISTS (SELECT 1 FROM old_aliases r WHERE r.alias_slug=a.alias_slug) RETURNING id
			)
			SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM eligible) THEN 'changed'
				WHEN EXISTS (SELECT 1 FROM conflicts) THEN 'conflict' ELSE 'saved' END AS status,
				(SELECT slug FROM saved) AS slug,
				1 / CASE WHEN (SELECT count(*) FROM saved)=(SELECT count(*) FROM allowed)
					AND (SELECT count(*) FROM revision)=(SELECT count(*) FROM saved)
					AND (SELECT count(*) FROM removed)=(SELECT count(*) FROM saved) * (
						SELECT count(*) FROM old_aliases r WHERE NOT EXISTS (SELECT 1 FROM alias_input a WHERE a.alias_slug=r.alias_slug))
					AND (SELECT count(*) FROM renamed)=(SELECT count(*) FROM saved) * (
						SELECT count(*) FROM old_aliases r JOIN alias_input a USING (alias_slug) WHERE r.alias_title<>a.alias_title)
					AND (SELECT count(*) FROM inserted)=(SELECT count(*) FROM saved) * (
						SELECT count(*) FROM alias_input a WHERE NOT EXISTS (SELECT 1 FROM old_aliases r WHERE r.alias_slug=a.alias_slug))
					THEN 1 ELSE 0 END AS atomic_guard
		`
		],
		{ isolationLevel: 'ReadCommitted' }
	);
	return results.at(-1)[0];
}
