import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectContent, assertSafeForAI, createContentPolicy } from '../src/lib/content-policy.js';
import { mergeInput, validateMerge } from '../src/lib/server/merge-contract.js';
import {
	evidencePassages,
	answerInput,
	validateAnswer
} from '../src/lib/server/answer-contract.js';
import { createAI } from '../src/lib/server/openai-core.js';

test('sensitive input never invokes an external semantic checker, including metadata', async () => {
	let called = 0;
	const check = async () => {
		called++;
		return { passed: true, reasons: [] };
	};
	for (const values of [
		['일반 본문', '대외비 자료명'],
		['제목', '010-1234-5678'],
		['별칭', 'person@example.com']
	]) {
		assert.equal((await inspectContent(values, check)).passed, false);
		assert.throws(() => assertSafeForAI(...values), /콘텐츠 보호/);
	}
	assert.equal(called, 0);
});
test('semantic skipped and failed are distinct from passed', async () => {
	const skipped = await inspectContent('공정 설명', async () => ({
		passed: null,
		reasons: [],
		skipped: true
	}));
	assert.equal(skipped.passed, true);
	assert.equal(skipped.semantic.passed, null);
	const failed = await inspectContent('공정 설명', async () => ({
		passed: false,
		reasons: ['제한 자료']
	}));
	assert.equal(failed.passed, false);
});

test('relaxed development policy permits ordinary internal information without semantic rejection', async () => {
	const policy = createContentPolicy('relaxed');
	const text =
		'대외비 업무 안내 · 담당자 홍길동 과장 · 사번 TEST-001 · 문의 test@example.com · 급여 업무 일정';
	let called = 0;
	const inspection = await policy.inspectContent(text, async () => {
		called++;
		throw Error('must not call');
	});
	assert.equal(inspection.passed, true);
	assert.equal(inspection.semantic.reason, 'relaxed_policy');
	assert.equal(inspection.semantic.skipped, true);
	assert.ok(inspection.warnings.includes('개인 연락처'));
	assert.equal(called, 0);
	assert.doesNotThrow(() => policy.assertSafeForAI(text));
	assert.throws(() => assertSafeForAI(text));
	assert.equal(createContentPolicy('unknown').mode, 'strict');
	const ai = createAI({ OPENAI_API_KEY: 'synthetic-unused-key' }, { policy });
	assert.equal((await ai.semanticGovernance(text)).reason, 'relaxed_policy');
	const draft = { title: '자료', content: text, aliases: [] };
	assert.doesNotThrow(() => mergeInput(draft, draft, { policy }));
	assert.equal(
		validateMerge({ content: text, summary: '갱신', conflicts: [] }, { policy }).content,
		text
	);
	const sources = evidencePassages(
		[{ id: 1, revision_id: 1, slug: 'fixture', title: '자료', content: text }],
		'업무',
		{ policy }
	);
	assert.ok(sources.length);
	assert.doesNotThrow(() => answerInput('담당자 test@example.com', sources, { policy }));
	assert.equal(
		validateAnswer(
			{ insufficient: false, paragraphs: [{ text, sources: [sources[0].id] }], conflicts: [] },
			sources,
			{ policy }
		).sources.length,
		1
	);
});

test('critical identifiers and credentials remain blocked locally in both policies', async () => {
	for (const mode of ['strict', 'relaxed']) {
		const policy = createContentPolicy(mode);
		let called = 0;
		for (const text of [
			'900101-1234567',
			'api_key=sk-proj-synthetic12345678901234567890',
			'password=synthetic-secret-only',
			'-----BEGIN PRIVATE KEY-----'
		]) {
			assert.throws(() => policy.assertSafeForAI('자료명', text), /콘텐츠 보호/);
			assert.equal(
				(
					await policy.inspectContent(text, async () => {
						called++;
					})
				).passed,
				false
			);
		}
		assert.equal(called, 0);
	}
});
