import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createLinkCatalog, linkedWikiTokens } from '../src/lib/wiki-links.js';

const documents = [
	{ id: '1', slug: 'rfcc', title: 'RFCC' },
	{ id: '2', slug: 'inspection', title: '설비 점검' },
	{ id: '3', slug: 'pump', title: 'Pump' },
	{ id: '4', slug: 'inspection-method', title: '설비 점검 방법' }
];
const catalog = createLinkCatalog(documents, [
	{ alias_title: '공정 설비', alias_slug: '공정-설비', document_id: '1' }
]);
const targets = (content, options = {}) =>
	linkedWikiTokens(content, catalog, options).connections.map((link) => link.target);

test('titles, aliases, casing and Korean particles link once per canonical document', () => {
	const result = linkedWikiTokens(
		'공정 설비는 RFCC의 별칭이다. 설비 점검을 수행한다. pump와 PUMP는 같다.',
		catalog
	);
	assert.deepEqual(
		result.connections.map((link) => [link.target, link.label]),
		[
			['rfcc', '공정 설비'],
			['inspection', '설비 점검'],
			['pump', 'pump']
		]
	);
	assert.equal(
		result.connections.every((link) => link.automatic),
		true
	);
	assert.deepEqual(targets('RFCC는 RFCC와 연결된다.', { sourceSlug: 'rfcc' }), []);
});

test('longest names win and substrings, numeric-only and ambiguous names are not guessed', () => {
	assert.deepEqual(targets('설비 점검 방법으로 시작한다. Pumpkin XR FCC XRFCC RFCC2 RFCC공정'), [
		'inspection-method'
	]);
	const index = createLinkCatalog([
		...documents,
		{ id: '5', slug: 'duplicate', title: 'rfcc' },
		{ id: '6', slug: 'number', title: '1234' },
		{ id: '7', slug: 'letter', title: 'A' }
	]);
	assert.deepEqual(
		linkedWikiTokens('RFCC pump 1234 A', index).connections.map((link) => link.target),
		['pump']
	);
	assert.deepEqual(index.ambiguous, ['RFCC']);
});

test('manual links win without nested links; code, URLs, images, HTML attributes and footnotes stay excluded', () => {
	const content =
		'RFCC와 [[RFCC|직접 링크]] 및 [[미작성 문서|표시 이름]].\n\n`Pump`\n\n```text\n설비 점검 방법\n```\n\n    Pump\n\n[Pump](https://example.invalid/RFCC) ![설비 점검](/image.png) https://example.invalid/Pump\n\n<div title="Pump">설비 점검</div>\n\n각주[^Pump]\n\n[^Pump]: 설비 점검 방법';
	const result = linkedWikiTokens(content, catalog);
	assert.deepEqual(result.connections, [{ target: 'rfcc', automatic: false, label: '직접 링크' }]);
	assert.deepEqual(result.missing, [{ slug: '미작성-문서', title: '미작성 문서' }]);
	assert.equal((marked.parser(result.tokens).match(/href="\/wiki\/rfcc"/g) || []).length, 1);
});

test('formatted prose, tables, blockquotes and internal Markdown links share the same graph rules', () => {
	assert.deepEqual(
		targets(
			'**RFCC**\n\n> 설비 점검\n\n| 항목 |\n|---|\n| Pump |\n\n[방법](/wiki/inspection-method)'
		),
		['inspection-method', 'rfcc', 'inspection', 'pump']
	);
});

test('direct URL precedence, deleted targets and huge IDs match actual document routing', () => {
	const index = createLinkCatalog(
		[
			{ id: '9007199254740993', slug: 'fixed-url', title: '현행 문서' },
			{ id: '9007199254740994', slug: 'other', title: '다른 문서' },
			{ id: '3', slug: 'deleted', title: '삭제 문서', deleted_at: '2026-01-01' }
		],
		[
			{ alias_slug: 'fixed-url', alias_title: '이전 별칭', document_id: '9007199254740994' },
			{ alias_slug: 'deleted', alias_title: '삭제 문서', document_id: '9007199254740994' }
		]
	);
	assert.deepEqual(
		linkedWikiTokens('이전 별칭, 삭제 문서', index).connections.map((link) => link.target),
		['fixed-url']
	);
	assert.equal(index.bySlug.get('fixed-url'), 'fixed-url');
	assert.equal(index.bySlug.has('deleted'), false);
});

test('new targets and alias changes are recalculated without touching source content', () => {
	const content = '새 설비와 공정 설비';
	assert.equal(linkedWikiTokens(content, createLinkCatalog([])).connections.length, 0);
	const index = createLinkCatalog([{ id: '1', title: '새 설비', slug: 'fixed' }]);
	assert.deepEqual(
		linkedWikiTokens(content, index).connections.map((link) => link.target),
		['fixed']
	);
	assert.equal(content, '새 설비와 공정 설비');
});

test('special characters are literal, labels are escaped and reusing a catalog is deterministic', () => {
	const index = createLinkCatalog([
		{ id: '1', title: 'Pump (A+B)', slug: 'safe' },
		{ id: '2', title: 'RFCC & CDU', slug: 'amp' }
	]);
	for (let i = 0; i < 3; i++) {
		const result = linkedWikiTokens('Pump (A+B), RFCC & CDU', index);
		assert.deepEqual(
			result.connections.map((link) => link.target),
			['safe', 'amp']
		);
		assert.match(marked.parser(result.tokens), /RFCC &amp; CDU/);
	}
});
