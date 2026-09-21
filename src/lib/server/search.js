import { db } from './db.js';
import { sessionRead } from './auth.js';
import { excerpt } from '../wiki-utils.js';
function searchResult(result) {
	return {
		...result,
		results: result.results.map((doc) => ({
			...doc,
			description: excerpt(doc.snippet, 320),
			isDraft: false,
			backlinks: [],
			related: []
		}))
	};
}
export async function searchDocuments(options) {
	const [row] =
		await db()`SELECT wv_search_documents_v1(${JSON.stringify(options)}::jsonb) AS result`;
	return searchResult(row.result);
}
export async function searchWithSession(cookies, options) {
	const { user, rows } = await sessionRead(
		cookies,
		(sql) => sql`SELECT wv_search_documents_v1(${JSON.stringify(options)}::jsonb) AS result`
	);
	return { user, result: rows[0] ? searchResult(rows[0].result) : null };
}
