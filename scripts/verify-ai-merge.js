// One bounded, synthetic real API test. Does not read or write user documents.
import OpenAI from 'openai';
import assert from 'node:assert/strict';
import { mergeInput, mergeSchema, validateMerge } from '../src/lib/server/merge-contract.js';
try {
	process.loadEnvFile?.();
} catch {}
if (!process.env.OPENAI_API_KEY) {
	console.log('SKIP real AI: no key');
	process.exit(0);
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 0 });
const input = mergeInput(
	{
		title: '가상 시험 기구 관리',
		content:
			'## 점검\n\n점검 주기는 7일입니다.\n\n## 보관\n\n사용하지 않을 때는 파란 보관함에 보관합니다.'
	},
	{
		title: '가상 시험 기구 관리',
		content: '## 점검\n\n점검 주기는 3일로 변경합니다.',
		source_name: '합성 검증 자료',
		aliases: []
	}
);
try {
	const start = Date.now();
	const response = await client.responses.create({
		model: process.env.OPENAI_MODEL || 'gpt-5-mini',
		store: false,
		input,
		text: { format: { type: 'json_schema', name: 'wiki_merge', strict: true, schema: mergeSchema } }
	});
	const result = validateMerge(JSON.parse(response.output_text));
	assert.match(result.content, /3일/);
	assert.match(result.content, /파란 보관함/);
	assert.ok(result.conflicts.some((c) => c.previous.includes('7일') && c.incoming.includes('3일')));
	console.log(
		JSON.stringify({
			result: 'PASS real OpenAI synthetic merge',
			model: response.model,
			elapsedMs: Date.now() - start,
			conflicts: result.conflicts,
			keptStorage: true,
			usage: response.usage
		})
	);
} catch (cause) {
	console.log(
		JSON.stringify({ result: 'FAIL real AI', status: cause.status || null, error: cause.name })
	);
	process.exitCode = 1;
}
