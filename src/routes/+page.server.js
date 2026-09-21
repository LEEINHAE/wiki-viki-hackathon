import { db } from '$lib/server/db.js';
import { searchDocuments } from '$lib/server/search.js';
import { buildKnowledgeGraph, documentSummary } from '$lib/knowledge.js';

export async function load({ url }) {
	const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
	const view = ['activity', 'map'].includes(url.searchParams.get('view'))
		? url.searchParams.get('view')
		: 'search';
	try {
		const sql = db();
		const [documents, aliases, drafts, revisions, announcements, discussions, results] =
			await Promise.all([
				sql`SELECT id,slug,title,content,editor_handle,updated_at FROM documents ORDER BY updated_at DESC`,
				sql`SELECT alias_slug,document_id FROM redirects`,
				sql`SELECT id,title,source_name,status,created_at FROM drafts WHERE status <> 'published' ORDER BY created_at DESC`,
				sql`SELECT COUNT(*)::int AS count FROM revisions WHERE created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
				sql`SELECT title,body,created_at FROM announcements ORDER BY created_at DESC LIMIT 4`,
				sql`SELECT ds.thread_title,ds.created_at,d.slug,d.title AS document_title FROM discussions ds JOIN documents d ON d.id=ds.document_id ORDER BY ds.created_at DESC LIMIT 5`,
				q ? searchDocuments(q) : []
			]);
		const graph = buildKnowledgeGraph(documents, aliases);
		return {
			q,
			view,
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
			graph: { nodes: graph.nodes, edges: graph.edges },
			missing: graph.missing
		};
	} catch (cause) {
		console.error('Wiki home data unavailable:', cause.message);
		return {
			q,
			view,
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
