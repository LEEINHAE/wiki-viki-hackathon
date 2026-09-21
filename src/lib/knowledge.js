import { slugify, createLinkCatalog, linkedWikiTokens } from './wiki-links.js';
export { slugify };

export const documentHref = (slug) => `/wiki/${encodeURIComponent(slug)}`;
export const maxDraftDocuments = 32;

export function validateDraftDocuments(documents) {
	if (!Array.isArray(documents) || !documents.length || documents.length > maxDraftDocuments)
		throw new Error('Invalid draft count');
	const seen = new Set();
	return documents.map((document) => {
		if (
			typeof document.title !== 'string' ||
			!Array.isArray(document.sections) ||
			!document.sections.length ||
			!document.sections.every(
				(section) =>
					typeof section.heading === 'string' &&
					typeof section.content === 'string' &&
					section.content.trim()
			) ||
			!Array.isArray(document.suggestedLinks) ||
			!document.suggestedLinks.every((value) => typeof value === 'string') ||
			!Array.isArray(document.aliases) ||
			!document.aliases.every((value) => typeof value === 'string')
		)
			throw new Error('Invalid draft content');
		const title = document.title.trim();
		const slug = slugify(title);
		if (!slug || seen.has(slug)) throw new Error('Empty or duplicate draft title');
		seen.add(slug);
		return { ...document, title, slug };
	});
}

export function linkTerms(content, titles) {
	let linked = content;
	for (const title of [...new Set(titles)].filter(Boolean).sort((a, b) => b.length - a.length)) {
		if (
			[...linked.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].some(
				(match) => slugify(match[1]) === slugify(title)
			)
		)
			continue;
		const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}`, 'u');
		let replaced = false;
		linked = linked
			.split(/(```[\s\S]*?```|`[^`\n]*`|\[\[[\s\S]*?\]\]|\[[^\]]*\]\([^)]*\))/g)
			.map((part, index) => {
				if (replaced || index % 2) return part;
				return part.replace(pattern, () => {
					replaced = true;
					return `[[${title}]]`;
				});
			})
			.join('');
	}
	return linked;
}
export function plainText(content = '') {
	return content
		.replace(/```[\s\S]*?```/g, '')
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^#{1,6}\s+.*$/gm, '')
		.replace(/[*_`~>|]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
export function categoryOf(document) {
	const title = document.title.toLowerCase();
	if (/wiki.viki:|위키비키:/.test(title)) return '위키 안내';
	if (/스팀|steam|유틸리티/.test(title)) return '유틸리티';
	if (/안전|비상|safety|emergency/.test(title)) return '안전';
	if (/절차|인계|정비|체크|process|handover|checklist/.test(title)) return '업무 절차';
	if (/설비|장비|equipment|탱크|재생탑/.test(title)) return '설비';
	if (/공정|rfcc|증류/.test(title)) return '공정';
	return '일반 지식';
}
export function documentSummary(document) {
	return {
		id: document.id,
		slug: document.slug,
		title: document.title,
		editor_handle: document.editor_handle,
		updated_at: document.updated_at,
		category: categoryOf(document),
		excerpt: plainText(document.content).slice(0, 240)
	};
}
export function searchTerms(query) {
	const words = query
		.toLowerCase()
		.replace(/[^\p{L}\p{N}:.~_%-]+/gu, ' ')
		.trim()
		.split(/\s+/);
	const stop =
		/^(?:무엇|무엇인가요|뭔가요|알려줘|알려주세요|설명|설명해줘|어떻게|대해|대한|what|is|are|the|how|does|a|an|and|of|to|please)$/;
	return [
		...new Set(
			words
				.filter((word) => word && !stop.test(word))
				.flatMap((word) => {
					const stem =
						word.length > 2
							? word.replace(/(?:에서는|에서|으로|이란|란|은|는|을|를|과|와|의|가)$/u, '')
							: word;
					return stem && stem !== word ? [word, stem] : [word];
				})
		)
	].slice(0, 10);
}
// Reading connections retain the parser's evidence and the existing snapshot order.
// Outgoing links use the same content that is rendered, even if a later snapshot
// contains an edit to the current document.
export function documentConnections(document, documents, catalog) {
	const outgoing = new Map(
		linkedWikiTokens(document.content, catalog, { sourceSlug: document.slug }).connections.map(
			(connection) => [connection.target, connection]
		)
	);
	const related = [],
		backlinks = [];
	const withReason = (doc, { automatic, label }) => ({
		...documentSummary(doc),
		connection: { automatic, label }
	});
	for (const other of documents) {
		if (other.deleted_at || other.slug === document.slug) continue;
		const connection = outgoing.get(other.slug);
		if (connection) related.push(withReason(other, connection));
		const incoming = linkedWikiTokens(other.content, catalog, {
			sourceSlug: other.slug
		}).connections.find((connection) => connection.target === document.slug);
		if (incoming) backlinks.push(withReason(other, incoming));
	}
	return { related, backlinks };
}

export function buildKnowledgeGraph(documents, aliases = []) {
	const catalog = createLinkCatalog(documents, aliases);
	const edges = [];
	const missing = new Map();
	const counts = new Map(documents.map((doc) => [doc.slug, 0]));
	for (const doc of documents) {
		const links = linkedWikiTokens(doc.content, catalog, { sourceSlug: doc.slug });
		for (const item of links.missing) missing.set(item.slug, item);
		for (const { target } of links.connections) {
			edges.push({ source: doc.slug, target });
			counts.set(target, counts.get(target) + 1);
		}
	}
	const hubs = documents
		.map((doc) => ({ ...documentSummary(doc), links: counts.get(doc.slug) }))
		.sort((a, b) => b.links - a.links || a.title.localeCompare(b.title, 'ko'));
	const center = hubs[0];
	const neighbors = center
		? new Set(
				edges
					.filter((edge) => edge.source === center.slug || edge.target === center.slug)
					.flatMap((edge) => [edge.source, edge.target])
			)
		: new Set();
	const nodes = center
		? [
				center,
				...hubs.filter((doc) => doc.slug !== center.slug && neighbors.has(doc.slug)).slice(0, 6)
			]
		: [];
	const visible = new Set(nodes.map((node) => node.slug));
	return {
		hubs,
		nodes,
		edges: edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
		allEdges: edges,
		linkCount: edges.length,
		missing: [...missing.values()]
	};
}
export function formatDate(value) {
	return new Intl.DateTimeFormat('ko-KR', {
		month: 'short',
		day: 'numeric',
		timeZone: 'Asia/Seoul'
	}).format(new Date(value));
}
export function validateAnswer(value, sources) {
	if (
		!value ||
		typeof value.title !== 'string' ||
		typeof value.insufficient !== 'boolean' ||
		!Array.isArray(value.paragraphs)
	)
		return null;
	const allowed = new Set(sources.map((source) => source.id));
	const paragraphs = value.paragraphs
		.filter(
			(part) =>
				typeof part.text === 'string' &&
				part.text.trim() &&
				Array.isArray(part.sourceIds) &&
				part.sourceIds.length &&
				part.sourceIds.every((id) => allowed.has(id))
		)
		.map((part) => ({ text: part.text.trim(), sourceIds: [...new Set(part.sourceIds)] }));
	if (value.insufficient || !paragraphs.length)
		return {
			status: 'insufficient',
			message: '검색된 문서만으로는 답변할 근거가 충분하지 않습니다. 아래 원문을 확인해 주세요.'
		};
	const used = new Set(paragraphs.flatMap((part) => part.sourceIds));
	return {
		status: 'complete',
		title: value.title,
		paragraphs,
		sources: sources.filter((source) => used.has(source.id))
	};
}
