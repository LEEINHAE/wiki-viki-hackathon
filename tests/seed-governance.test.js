import test from 'node:test';
import assert from 'node:assert/strict';
import { structureSeedDocument } from '../scripts/lib/seed-files.js';
import { generatedSeed, seedAIResponse } from './fixtures/seed-source.js';

test('seed structuring independently blocks sensitive filenames and source text before any SDK call', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls += 1;
		return seedAIResponse(generatedSeed);
	});
	for (const [text, name] of [
		['장비 점검', '900101-1000000.docx'],
		['password=NotARealSecret42!', '장비.docx'],
		['api_key=NotARealSecret42!', '장비.docx']
	]) {
		for (const apiKey of ['', 'test-only-key'])
			await assert.rejects(structureSeedDocument(text, name, { apiKey }), {
				name: 'ContentBlockedError'
			});
	}
	assert.equal(calls, 0);
});

test('keyless seed structuring keeps the filename title and source-based draft without external requests', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => {
		assert.fail('No external request expected');
	});
	const result = await structureSeedDocument('점검 기록\n둘째 문단', '장비#1.DOCX');
	assert.equal(result.title, '장비#1');
	assert.equal(result.content, '## 개요\n\n점검 기록\n둘째 문단');
	assert.deepEqual(result.aliases, []);
});

test('seed generation rejects unsafe output fields and malformed or incomplete responses', async (t) => {
	for (const [label, value] of [
		['sensitive title', { ...generatedSeed, title: '900101-1000000 장비' }],
		['sensitive alias', { ...generatedSeed, aliases: ['900101-1000000'] }],
		[
			'sensitive body',
			{ ...generatedSeed, sections: [{ heading: '개요', content: 'password=NotARealSecret42!' }] }
		],
		['invalid aliases', { ...generatedSeed, aliases: {} }],
		['missing sections', { ...generatedSeed, sections: [] }]
	]) {
		await t.test(label, async (st) => {
			st.mock.method(globalThis, 'fetch', async () => seedAIResponse(value));
			await assert.rejects(
				structureSeedDocument('점검 기록', '장비.docx', { apiKey: 'test-only-key' })
			);
		});
	}
	await t.test('incomplete response', async (st) => {
		st.mock.method(globalThis, 'fetch', async () => seedAIResponse(generatedSeed, 'incomplete'));
		await assert.rejects(
			structureSeedDocument('점검 기록', '장비.docx', { apiKey: 'test-only-key' })
		);
	});
});
