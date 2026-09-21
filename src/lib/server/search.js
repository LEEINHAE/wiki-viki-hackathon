import { db } from './db.js';
import { documentSummary, searchTerms } from '$lib/knowledge.js';

export async function searchDocuments(query, limit = 40) {
	const terms = searchTerms(query);
	if (!terms.length) return [];
	const sql = db();
	const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`);
	return sql`
		SELECT d.*, CASE WHEN LOWER(d.title) = ${query.toLowerCase()} THEN 100 ELSE 0 END
			+ (SELECT COUNT(*) * 10 FROM unnest(${patterns}::text[]) term WHERE d.title ILIKE term)
			+ (SELECT COUNT(*) * 5 FROM redirects r WHERE r.document_id=d.id AND r.alias_title ILIKE ANY(${patterns}::text[]))
			+ (SELECT COUNT(*) FROM unnest(${patterns}::text[]) term WHERE d.content ILIKE term) AS relevance
		FROM documents d
		WHERE d.deleted_at IS NULL AND (d.title ILIKE ANY(${patterns}::text[]) OR d.content ILIKE ANY(${patterns}::text[])
			OR EXISTS (SELECT 1 FROM redirects r WHERE r.document_id=d.id AND r.alias_title ILIKE ANY(${patterns}::text[])))
		ORDER BY relevance DESC, d.updated_at DESC LIMIT ${limit}`;
}
export async function suggestions(query) {
	return (await searchDocuments(query, 5)).map(documentSummary);
}
