import { db } from '$lib/server/db.js';
import { getCatalog } from '$lib/server/catalog.js';
import { searchCatalog } from '$lib/wiki-utils.js';

export async function load({ url }) {
	const q = url.searchParams.get('q')?.trim() || '';
	const field = url.searchParams.get('field') || '';
	const layout = ['search', 'activity', 'map'].includes(url.searchParams.get('layout'))
		? url.searchParams.get('layout')
		: 'search';
	const started = performance.now();
	try {
		const sql = db();
		const [catalog, changes, weekly] = await Promise.all([
			getCatalog({ drafts: true }),
			sql`SELECT r.id, r.summary, r.editor_handle, r.created_at AS updated_at, d.slug, d.title FROM revisions r JOIN documents d ON d.id=r.document_id ORDER BY r.created_at DESC LIMIT 12`,
			sql`SELECT count(*) AS count FROM revisions WHERE created_at >= NOW() - INTERVAL '7 days'`
		]);
		const allResults = searchCatalog([...catalog.documents, ...catalog.drafts], q);
		const results = field ? allResults.filter((doc) => doc.field === field) : allResults;
		const facets = [...new Set(allResults.map((doc) => doc.field))].map((name) => ({
			name,
			count: allResults.filter((doc) => doc.field === name).length
		}));
		const trending = [...catalog.documents]
			.sort((a, b) => Number(b.views || 0) - Number(a.views || 0))
			.slice(0, 6);
		const hubs = [...catalog.documents]
			.sort((a, b) => b.backlinks.length - a.backlinks.length)
			.slice(0, 7);
		return {
			q,
			field,
			layout,
			results,
			facets,
			changes,
			trending,
			hubs,
			drafts: catalog.drafts.slice(0, 3),
			graph: {
				documents: catalog.documents.map(({ slug, title, backlinks }) => ({
					slug,
					title,
					count: backlinks.length
				})),
				edges: catalog.edges
			},
			missing: catalog.missing,
			stats: {
				documents: catalog.documents.length,
				edits: Number(weekly[0].count),
				links: catalog.edges.length,
				drafts: catalog.drafts.length
			},
			elapsed: ((performance.now() - started) / 1000).toFixed(2),
			databaseReady: true
		};
	} catch (cause) {
		console.error('Home load failed:', cause.message);
		return {
			q,
			field,
			layout,
			results: [],
			facets: [],
			changes: [],
			trending: [],
			hubs: [],
			drafts: [],
			missing: [],
			graph: { documents: [], edges: [] },
			stats: { documents: 0, edits: 0, links: 0, drafts: 0 },
			databaseReady: false
		};
	}
}
