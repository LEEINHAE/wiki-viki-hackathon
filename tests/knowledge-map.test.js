import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeGraph, knowledgeMapHref } from '../src/lib/knowledge.js';
import { mapDocuments, mapAliases } from './fixtures/knowledge-map.js';

test('successive centers reveal their actual neighbors beyond the initial neighborhood', () => {
	const before = structuredClone(mapDocuments);
	const root = buildKnowledgeGraph(mapDocuments, mapAliases);
	assert.equal(root.nodes[0].slug, 'root');
	assert.equal(
		root.nodes.some((n) => n.slug === 'deep'),
		false
	);
	const branch = buildKnowledgeGraph(mapDocuments, mapAliases, { centerSlug: 'branch' });
	assert.equal(branch.nodes[0].slug, 'branch');
	assert.deepEqual(new Set(branch.nodes.slice(1).map((n) => n.slug)), new Set(['root', 'deep']));
	const deep = buildKnowledgeGraph(mapDocuments, mapAliases, { centerSlug: 'deep' });
	assert.equal(deep.nodes[0].slug, 'deep');
	assert.deepEqual(new Set(deep.nodes.slice(1).map((n) => n.slug)), new Set(['branch', 'final']));
	assert.equal(deep.nodes.find((n) => n.slug === 'branch').incoming, true);
	assert.equal(deep.nodes.find((n) => n.slug === 'branch').outgoing, false);
	assert.equal(deep.nodes.find((n) => n.slug === 'final').outgoing, true);
	assert.equal(deep.linkCount, root.linkCount);
	assert.deepEqual(deep.hubs, root.hubs);
	assert.deepEqual(mapDocuments, before);
});

test('every neighbor is reachable in bounded pages with no duplicates or disconnected edges', () => {
	const first = buildKnowledgeGraph(mapDocuments, mapAliases, { centerSlug: 'root' });
	const second = buildKnowledgeGraph(mapDocuments, mapAliases, { centerSlug: 'root', page: 2 });
	assert.equal(first.neighborCount, 8);
	assert.equal(first.pages, 2);
	assert.equal(first.nodes.length, 7);
	assert.equal(second.nodes.length, 3);
	assert.equal(second.nodes[0].slug, 'root');
	assert.equal(
		new Set([...first.nodes.slice(1), ...second.nodes.slice(1)].map((n) => n.slug)).size,
		8
	);
	for (const graph of [first, second]) {
		const slugs = new Set(graph.nodes.map((n) => n.slug));
		assert.ok(graph.edges.every((e) => slugs.has(e.source) && slugs.has(e.target)));
	}
	for (const page of ['bad', -2, 1.5, Infinity])
		assert.equal(buildKnowledgeGraph(mapDocuments, mapAliases, { page }).page, 1);
	assert.equal(buildKnowledgeGraph(mapDocuments, mapAliases, { page: 999 }).page, 2);
});

test('aliases, isolated, removed and unknown centers have explicit truthful states', () => {
	const alias = buildKnowledgeGraph(mapDocuments, mapAliases, { centerSlug: 'old-name' });
	assert.equal(alias.nodes[0].slug, 'deep');
	assert.equal(alias.centerUnavailable, false);
	const solo = buildKnowledgeGraph(mapDocuments, mapAliases, { centerSlug: 'standalone', page: 9 });
	assert.equal(solo.nodes[0].slug, 'standalone');
	assert.equal(solo.neighborCount, 0);
	assert.deepEqual(solo.edges, []);
	assert.equal(solo.page, 1);
	const removed = mapDocuments.map((d) =>
		d.slug === 'deep' ? { ...d, deleted_at: '2026-01-01' } : d
	);
	for (const centerSlug of ['deep', 'missing']) {
		const graph = buildKnowledgeGraph(removed, mapAliases, { centerSlug });
		assert.equal(graph.centerUnavailable, true);
		assert.equal(graph.nodes[0].slug, 'root');
		assert.equal(
			graph.hubs.some((d) => d.slug === 'deep'),
			false
		);
		assert.ok(graph.allEdges.every((e) => e.source !== 'deep' && e.target !== 'deep'));
	}
	const empty = buildKnowledgeGraph([], [], { centerSlug: 'missing' });
	assert.deepEqual(empty.nodes, []);
	assert.equal(empty.neighborCount, 0);
});

test('reserved deleted routes cannot be selected or linked through conflicting aliases', () => {
	const documents = [
		{ id: '1', slug: 'reserved', title: '삭제 문서', content: '', deleted_at: '2026-01-01' },
		{ id: '2', slug: 'active', title: '활성 문서', content: '[[reserved]]' }
	];
	const graph = buildKnowledgeGraph(documents, [{ alias_slug: 'reserved', document_id: '2' }], {
		centerSlug: 'reserved'
	});
	assert.equal(graph.centerUnavailable, true);
	assert.deepEqual(graph.edges, []);
	assert.deepEqual(graph.missing, [{ slug: 'reserved', title: 'reserved' }]);
});

test('map URLs round-trip literal document slugs without turning them into query or fragment syntax', () => {
	const slug = '한글 & % / ? #';
	const url = new URL(knowledgeMapHref(slug, 2), 'http://local');
	assert.equal(url.pathname, '/');
	assert.equal(url.searchParams.get('view'), 'map');
	assert.equal(url.searchParams.get('center'), slug);
	assert.equal(url.searchParams.get('mapPage'), '2');
	assert.equal(url.hash, '#knowledge-map');
	assert.equal(new URL(knowledgeMapHref('next'), url).searchParams.has('mapPage'), false);
});
