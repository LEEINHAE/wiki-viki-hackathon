// One bounded call with synthetic documents only. Never loads user documents.
import OpenAI from 'openai';
import assert from 'node:assert/strict';
import {
	evidencePassages,
	answerInput,
	answerSchema,
	validateAnswer
} from '../src/lib/server/answer-contract.js';
if (!process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY is required');
const question = '검증용 점검 주기와 기록 보관 위치를 알려주세요';
const documents = [
	{
		id: 1,
		revision_id: 11,
		title: '점검 예시',
		slug: 'inspection-fixture',
		version: 'synthetic-1',
		content: '## 점검 주기\n\n검증용 장치의 점검 주기는 3일입니다. 이것은 합성 테스트 자료입니다.'
	},
	{
		id: 2,
		revision_id: 12,
		title: '보관 예시',
		slug: 'storage-fixture',
		version: 'synthetic-2',
		content:
			'## 기록 보관\n\n검증용 장치의 점검 기록은 파란 보관함에 보관합니다. 이것은 합성 테스트 자료입니다.'
	}
];
const sources = evidencePassages(documents, question);
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 110000, maxRetries: 0 });
const started = performance.now();
const response = await client.responses.create({
	model: process.env.OPENAI_MODEL || 'gpt-5-mini',
	store: false,
	max_output_tokens: 4096,
	input: answerInput(question, sources),
	text: {
		format: { type: 'json_schema', name: 'wiki_search_answer', strict: true, schema: answerSchema }
	}
});
const answer = validateAnswer(JSON.parse(response.output_text), sources);
assert.equal(answer.insufficient, false);
assert.equal(new Set(answer.sources.map((s) => s.documentId)).size, 2);
assert.match(answer.paragraphs.map((p) => p.text).join(' '), /3일/);
assert.match(answer.paragraphs.map((p) => p.text).join(' '), /파란/);
console.log(
	JSON.stringify(
		{
			status: 'PASS',
			model: response.model,
			elapsedMs: Math.round(performance.now() - started),
			documents: answer.sources.map((s) => s.documentId),
			citationCount: answer.sources.length,
			usage: response.usage
		},
		null,
		2
	)
);
