import { searchOptions } from '$lib/search.js';
import { searchDocuments } from '$lib/server/search.js';
import { homeSummary, knowledgeGraph } from '$lib/server/discovery.js';
export async function load({ url }) {
	const options = searchOptions(url.searchParams);
	const layout = ['search', 'activity', 'map'].includes(
		url.searchParams.get('view') || url.searchParams.get('layout')
	)
		? url.searchParams.get('view') || url.searchParams.get('layout')
		: 'search';
	const browsing = !!(
		options.q ||
		url.searchParams.has('browse') ||
		(layout !== 'map' && (options.field || options.tag || options.state))
	);
	const common = { ...options, layout, browsing, center: url.searchParams.get('center') || '' };
	const started = performance.now();
	try {
		const [summary, search, graph] = await Promise.all([
			homeSummary(),
			browsing ? searchDocuments(options) : { results: [], facets: [], total: 0 },
			layout === 'map'
				? knowledgeGraph({ center: common.center, field: options.field })
				: { documents: [], edges: [], center: '' }
		]);
		return {
			...common,
			...summary,
			...search,
			graph,
			databaseReady: true,
			elapsed: ((performance.now() - started) / 1000).toFixed(2)
		};
	} catch (cause) {
		console.error('Home load failed:', cause.code || cause.name);
		return {
			...common,
			results: [],
			facets: [],
			total: 0,
			changes: [],
			trending: [],
			hubs: [],
			drafts: [],
			announcements: [],
			discussions: [],
			missing: [],
			graph: { documents: [], edges: [], center: '' },
			stats: { documents: 0, edits: 0, links: 0, drafts: 0 },
			databaseReady: false
		};
	}
}
