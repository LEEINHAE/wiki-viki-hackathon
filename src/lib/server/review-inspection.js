import { db } from './db.js';
import { inspectContent } from './governance.js';
import { semanticGovernance } from './openai.js';
export async function inspectDocumentChange(document, content, ...extra) {
	const [aliases, tags] = await Promise.all([
		db()`SELECT alias_title FROM redirects WHERE document_id=${document.id}`,
		db()`SELECT tag FROM wv_document_tags WHERE document_id=${document.id}`
	]);
	return inspectContent(
		[
			document.title,
			content,
			document.description,
			document.source_name,
			...aliases.map((a) => a.alias_title),
			...tags.map((t) => t.tag),
			...extra
		],
		semanticGovernance
	);
}
