import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wikiTargets } from '../src/lib/wiki-utils.js';
import { renderWikiHtml, buildToc, headingSourceRange } from '../src/lib/wiki-renderer.js';

test('preview and article rendering: heading hierarchy, legacy anchors and fenced code', () => {
	const text = '## 개요\n### 상세\n```md\n# 제목이 아닌 코드\n```\n## 결론';
	assert.deepEqual(
		buildToc(text).map((h) => h.number),
		['1', '1.1', '2']
	);
	const html = renderWikiHtml(text);
	assert.match(html, /id="section-1"/);
	assert.match(html, /id="heading-상세"/);
	assert.equal(buildToc('## 추가\n' + text)[1].id, buildToc(text)[0].id);
});
test('safe HTML, image URLs, tables, aliases, missing links and footnote returns', () => {
	const html = renderWikiHtml(
		'<script>alert(1)</script>\n\n[bad](javascript:alert) ![bad](javascript:alert)\n\n[[별칭]] [[없는 문서]]\n\n|A|B|\n|-|-|\n|1|2|\n\n설명[^1] 다시[^1]\n\n[^1]: 출처',
		{ known: new Set(['별칭']) }
	);
	assert.ok(!html.includes('<script>'));
	assert.ok(!html.includes('href="javascript:'));
	assert.ok(!html.includes('src="javascript:'));
	assert.match(html, /table-scroll/);
	assert.match(html, /wiki-link missing/);
	assert.match(html, /href="#fnref-1-2"/);
});

test('code examples do not become wiki links or graph targets', () => {
	const source = '```md\n[[코드 예시]] `inline`\n```\n\n`[[인라인 예시]]`\n\n[[실제 링크]]';
	assert.deepEqual(wikiTargets(source), ['실제 링크']);
	const html = renderWikiHtml(source);
	assert.match(html, /\[\[코드 예시\]\]/);
	assert.match(html, /\[\[인라인 예시\]\]/);
	assert.ok(!html.includes('/wiki/코드'));
});

test('section entry selects the requested repeated heading and never its fenced example', () => {
	const content = '```md\n## 점검\n```\n\n## 점검\n첫 본문\n\n## 점검\n두 번째 본문\n';
	const range = headingSourceRange(content, 'heading-점검-2');
	assert.equal(range.start, content.lastIndexOf('## 점검'));
	assert.equal(content.slice(range.start, range.end), '## 점검');
	assert.equal(headingSourceRange('제목\n====\n\n본문', 'heading-제목').end, 7);
});
