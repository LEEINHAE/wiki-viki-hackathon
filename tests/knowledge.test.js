import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildKnowledgeGraph,
	plainText,
	searchTerms,
	validateAnswer
} from '../src/lib/knowledge.js';

test('links resolve aliases once and distinguish missing titles from prefixes', () => {
	const docs = [
		{ id: '1', slug: 'a', title: 'A', content: '[[B]] [[B|again]] [[Bee]] [[B missing]] [[A]]' },
		{ id: '2', slug: 'b', title: 'B', content: '[[A]]' }
	];
	const graph = buildKnowledgeGraph(docs, [{ alias_slug: 'bee', document_id: 2 }]);
	assert.equal(graph.linkCount, 2);
	assert.deepEqual(graph.missing, [{ title: 'B missing', slug: 'b-missing' }]);
	assert.equal(graph.hubs.find((doc) => doc.slug === 'b').links, 1);
	assert.equal(graph.nodes.length, 2);
});

test('empty and unlinked collections still produce a usable map', () => {
	assert.deepEqual(buildKnowledgeGraph([]).nodes, []);
	const graph = buildKnowledgeGraph([{ id: 1, slug: 'solo', title: 'Solo', content: '' }]);
	assert.equal(graph.nodes.length, 1);
	assert.equal(graph.linkCount, 0);
});

test('Korean questions and multiword English queries retain useful search terms', () => {
	assert.ok(searchTerms('RFCC는 무엇인가요?').includes('rfcc'));
	assert.ok(searchTerms('산단스팀과 RFCC의 관계').includes('산단스팀'));
	assert.deepEqual(searchTerms('What is shift handover?'), ['shift', 'handover']);
	assert.deepEqual(searchTerms('   '), []);
});

test('plain excerpts keep wiki link labels without raw Markdown', () => {
	assert.equal(
		plainText('## 정의\n\n**설명** [[RFCC|공정]]과 [원문](/wiki/a).'),
		'설명 공정과 원문.'
	);
});

const sources = [
	{ id: 1, title: 'A', slug: 'a' },
	{ id: 2, title: 'B', slug: 'b' }
];
test('AI output returns only validated, actually cited sources', () => {
	const result = validateAnswer(
		{
			title: '설명',
			insufficient: false,
			paragraphs: [{ text: '근거가 있는 설명', sourceIds: [2, 2] }]
		},
		sources
	);
	assert.equal(result.status, 'complete');
	assert.deepEqual(result.sources, [sources[1]]);
	assert.deepEqual(result.paragraphs[0].sourceIds, [2]);
});

test('fabricated citations, missing citations and insufficient evidence never become an answer', () => {
	for (const ids of [[999], [], [1, 999]]) {
		assert.equal(
			validateAnswer(
				{
					title: '설명',
					insufficient: false,
					paragraphs: [{ text: '확인되지 않은 내용', sourceIds: ids }]
				},
				sources
			).status,
			'insufficient'
		);
	}
	assert.equal(
		validateAnswer({ title: '설명', insufficient: true, paragraphs: [] }, sources).status,
		'insufficient'
	);
	assert.equal(validateAnswer({}, sources), null);
});
