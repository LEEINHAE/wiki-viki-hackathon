import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToc } from '../src/lib/wiki-headings.js';

test('wiki sections and subsections have readable numbers starting at one', () => {
	const items = buildToc('## 개요\n### 배경\n### 목적\n#### 상세\n## 절차\n### 확인');
	assert.deepEqual(
		items.map(({ number }) => number),
		['1', '1.1', '1.2', '1.2.1', '2', '2.1']
	);
	assert.deepEqual(
		items.map(({ id }) => id),
		['section-1', 'section-2', 'section-3', 'section-4', 'section-5', 'section-6']
	);
});

test('the contents follows Markdown headings, including setext, and ignores code examples', () => {
	const items = buildToc(
		'개요\n===\n\n```md\n## 코드 속 제목\n```\n\n    # 들여쓴 코드\n\n절차\n---\n\n> ### 참고\n\n## 마무리'
	);
	assert.deepEqual(
		items.map(({ title, number }) => [title, number]),
		[
			['개요', '1'],
			['절차', '1.1'],
			['참고', '1.1.1'],
			['마무리', '1.2']
		]
	);
});

test('contents labels omit formatting and link syntax, and repeated titles have distinct anchors', () => {
	const items = buildToc(
		'## **개요** ###\n## [[RFCC|공정]] 및 [도움말](/wiki/help)\n## `코드`와 ~~이전~~ 설명\n## 개요'
	);
	assert.deepEqual(
		items.map(({ title }) => title),
		['개요', '공정 및 도움말', '코드와 이전 설명', '개요']
	);
	assert.equal(new Set(items.map(({ id }) => id)).size, 4);
	assert.deepEqual(buildToc('본문만 있는 문서'), []);
});
