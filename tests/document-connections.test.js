import test from 'node:test';
import assert from 'node:assert/strict';
import * as knowledge from '../src/lib/knowledge.js';
import { createLinkCatalog } from '../src/lib/wiki-links.js';

const documents = [
	{
		id: '1',
		slug: 'current',
		title: '교대 기록',
		content:
			'공정 별칭은 확인 대상입니다. [[guide|저장된 안내]] [[guide|저장된 안내]] [[current]] [[missing]]'
	},
	{
		id: '2',
		slug: 'guide',
		title: '정비 절차',
		content: '[이전 안내](/wiki/old-current#section-1)'
	},
	{ id: '3', slug: 'rfcc', title: 'RFCC', content: '교대 기록을 확인합니다.' },
	{
		id: '4',
		slug: 'ignored',
		title: '코드 예제',
		content: '`교대 기록` [교대 기록](https://example.invalid/)'
	}
];
const aliases = [
	{ alias_slug: 'old-rfcc', alias_title: '공정 별칭', document_id: '3' },
	{ alias_slug: 'old-current', alias_title: '기록 별칭', document_id: '1' }
];
const catalog = createLinkCatalog(documents, aliases);

test('reader connections preserve canonical order, direction and actual automatic/manual evidence', () => {
	const before = structuredClone(documents);
	const result = knowledge.documentConnections(documents[0], documents, catalog);
	assert.deepEqual(
		result.related.map((d) => [d.slug, d.connection]),
		[
			['guide', { automatic: false, label: '저장된 안내' }],
			['rfcc', { automatic: true, label: '공정 별칭' }]
		]
	);
	assert.deepEqual(
		result.backlinks.map((d) => [d.slug, d.connection]),
		[
			['guide', { automatic: false, label: '이전 안내' }],
			['rfcc', { automatic: true, label: '교대 기록' }]
		]
	);
	assert.deepEqual(documents, before);
});

test('outgoing reasons use the displayed document content even when the catalog snapshot contains a newer source', () => {
	const displayed = { ...documents[0], content: '[[guide|읽고 있는 링크]]' };
	const result = knowledge.documentConnections(displayed, documents, catalog);
	assert.deepEqual(
		result.related.map((d) => [d.slug, d.connection.label]),
		[['guide', '읽고 있는 링크']]
	);
	assert.equal(result.backlinks.length, 2);
});

test('deleted and ambiguous targets, self references and opaque source tokens cannot invent reasons', () => {
	const active = [
		{ ...documents[0], content: 'RFCC [[current]] `정비 절차`' },
		{ ...documents[1], deleted_at: '2026-09-22' },
		documents[2],
		{ id: '5', slug: 'duplicate', title: 'RFCC', content: '다른 자료' }
	];
	const result = knowledge.documentConnections(active[0], active, createLinkCatalog(active));
	assert.deepEqual(result.related, []);
	assert.deepEqual(
		result.backlinks.map((d) => d.slug),
		['rfcc']
	);
});

test('explicit stored links win over prose matches and do not manufacture extra edges or alter raw labels', () => {
	const displayed = { ...documents[0], content: 'RFCC [<img src=x> & **원문**](/wiki/rfcc)' };
	const result = knowledge.documentConnections(displayed, documents, catalog);
	assert.deepEqual(
		result.related.map((d) => d.connection),
		[{ automatic: false, label: '<img src=x> & **원문**' }]
	);
	assert.deepEqual(
		knowledge.documentConnections({ ...displayed, content: '' }, documents, catalog).related,
		[]
	);
});
