import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDocumentOverview, ensureMarkdownOverview } from '../src/lib/document-overview.js';
import { trendingQuery } from '../src/lib/trending.js';
import { requiredRole } from '../src/lib/auth-policy.js';

test('AI documents keep the original sections and place a factual overview first', () => {
	const doc = {
		description: '원문에서 생성된 요약입니다.',
		sections: [{ heading: '절차', content: '원래 절차 본문' }]
	};
	assert.deepEqual(ensureDocumentOverview(doc).sections, [
		{ heading: '개요', content: doc.description },
		...doc.sections
	]);
	assert.equal(doc.sections.length, 1);
	const existing = {
		sections: [
			{ heading: '상세', content: '상세 내용' },
			{ heading: '1. 개요', content: '기존 개요' }
		]
	};
	assert.deepEqual(ensureDocumentOverview(existing).sections, [
		{ heading: '개요', content: '기존 개요' },
		{ heading: '상세', content: '상세 내용' }
	]);
	const missingSummary = ensureDocumentOverview({
		sections: [{ heading: '정의', content: '근거가 있는 첫 문단.\n\n다음 문단.' }]
	});
	assert.equal(missingSummary.sections[0].content, '근거가 있는 첫 문단.');
	assert.equal(ensureMarkdownOverview('## 개요\n\n기존 개요'), '## 개요\n\n기존 개요');
	const code = '```md\n## 개요\n```\n\n본문 근거.\n\n## 상세\n\n나머지';
	assert.equal(ensureMarkdownOverview(code), '## 개요\n\n본문 근거.\n\n' + code);
});

test('trending normalizes submitted queries and excludes sensitive or invalid data', () => {
	assert.deepEqual(trendingQuery('  ＲＦＣＣ   점검 '), { query: 'RFCC 점검', key: 'rfcc 점검' });
	for (const query of [
		'',
		'x',
		'x'.repeat(81),
		'test@example.com',
		'900101-1234567',
		'password=synthetic-secret-only',
		'😀',
		'\u0000RFCC'
	])
		assert.equal(trendingQuery(query), null);
	assert.equal(requiredRole('/api/trending', 'POST'), 'reader');
});
