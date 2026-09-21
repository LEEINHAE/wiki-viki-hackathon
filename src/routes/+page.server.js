import { db } from '$lib/server/db.js';
import { readLinkSnapshot } from '$lib/server/document-links.js';
import { searchDocuments } from '$lib/server/search.js';
import { buildKnowledgeGraph, categoryOf, documentSummary } from '$lib/knowledge.js';

function homeBrowse(documents, category) {
	const counts = new Map();
	for (const document of documents) {
		const name = categoryOf(document);
		counts.set(name, (counts.get(name) || 0) + 1);
	}
	const selected = documents.filter(
		(document) => category === '전체' || categoryOf(document) === category
	);
	return {
		category,
		categories: [...counts]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
		total: selected.length,
		documents: selected.slice(0, 12).map(documentSummary)
	};
}

export async function load({ url }) {
	const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
	const category = (url.searchParams.get('category') || '전체').trim().slice(0, 64) || '전체';
	const view = ['activity', 'map'].includes(url.searchParams.get('view'))
		? url.searchParams.get('view')
		: 'search';
	try {
		const sql = db();
		const [snapshot, drafts, revisions, announcements, discussions, results] = await Promise.all([
			readLinkSnapshot({ content: true }),
			sql`SELECT id,title,source_name,status,created_at FROM drafts WHERE status <> 'published' ORDER BY created_at DESC`,
			sql`SELECT COUNT(*)::int AS count FROM revisions r JOIN documents d ON d.id=r.document_id WHERE d.deleted_at IS NULL AND r.created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
			sql`SELECT title,body,created_at FROM announcements ORDER BY created_at DESC LIMIT 4`,
			sql`SELECT ds.thread_title,ds.created_at,d.slug,d.title AS document_title FROM discussions ds JOIN documents d ON d.id=ds.document_id WHERE d.deleted_at IS NULL ORDER BY ds.created_at DESC LIMIT 5`,
			q ? searchDocuments(q) : []
		]);
		const { documents, aliases } = snapshot;
		const graph = buildKnowledgeGraph(
			documents,
			aliases,
			view === 'map'
				? {
						centerSlug: url.searchParams.get('center') || '',
						page: url.searchParams.get('mapPage') || 1
					}
				: {}
		);
		return {
			q,
			view,
			browse: !q && view === 'search' ? homeBrowse(documents, category) : null,
			databaseReady: true,
			announcements,
			discussions,
			results: results.map(documentSummary),
			changes: documents.slice(0, 12).map(documentSummary),
			drafts,
			stats: {
				documents: documents.length,
				edits: revisions[0].count,
				links: graph.linkCount,
				drafts: drafts.length
			},
			hubs: graph.hubs.slice(0, 6),
			graph: {
				nodes: graph.nodes,
				edges: graph.edges,
				neighborCount: graph.neighborCount,
				page: graph.page,
				pages: graph.pages,
				centerUnavailable: graph.centerUnavailable,
				documents:
					view === 'map'
						? graph.hubs
								.map(({ slug, title }) => ({ slug, title }))
								.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
						: []
			},
			missing: graph.missing
		};
	} catch (cause) {
		console.error('Wiki home data unavailable:', cause.message);
		return {
			q,
			view,
			browse: { category, categories: [], documents: [], total: null },
			databaseReady: false,
			announcements: [],
			discussions: [],
			results: [],
			changes: [],
			drafts: [],
			stats: null,
			hubs: [],
			graph: { nodes: [], edges: [] },
			missing: []
		};
	}
}
