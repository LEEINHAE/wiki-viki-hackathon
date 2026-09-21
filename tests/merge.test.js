import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates, validMergeResult } from '../src/lib/merge.js';

const result = () => ({
	content: '3일마다 점검. [[보관]] 절차 유지.',
	summary: '주기 변경',
	conflicts: [{ topic: '주기', previous: '7일', incoming: '3일' }]
});

test('merge candidates normalize titles, slugs, redirect labels and routes without semantic guesses', () => {
	const documents = [
		{ id: '1', title: 'ＡＢＣ 점검', slug: 'legacy', aliases: [] },
		{ id: '2', title: '다른 제목', slug: 'abc-점검', aliases: [] },
		{ id: '3', title: '별개', slug: 'old', aliases: ['장비 점검'] },
		{ id: '4', title: '별개 둘', slug: 'different', aliases: ['장비-점검'] },
		{ id: '5', title: '장비 관련 개념', slug: 'unmatched', aliases: [] }
	];
	const candidates = mergeCandidates({ title: 'abc_점검', aliases: ['장비 점검'] }, documents);
	assert.deepEqual(
		candidates.filter((item) => item.matched).map((item) => item.id),
		['1', '2', '3', '4']
	);
	assert.equal(candidates.length, 5);
	assert.equal(documents[0].matched, undefined);
	assert.equal(
		mergeCandidates({ title: '!!!', aliases: [] }, [{ title: '???', slug: '...', aliases: [] }])[0]
			.matched,
		false
	);
});

test('merge result strictly validates structure and every documented boundary without truncation', () => {
	assert.equal(validMergeResult(result()), true);
	assert.equal(
		validMergeResult({
			content: 'x'.repeat(200000),
			summary: 'x'.repeat(2000),
			conflicts: Array.from({ length: 30 }, () => ({
				topic: 'x'.repeat(3000),
				previous: 'x'.repeat(3000),
				incoming: 'x'.repeat(3000)
			}))
		}),
		true
	);
	for (const invalid of [
		null,
		[],
		{},
		{ ...result(), extra: true },
		{ ...result(), content: ' ' },
		{ ...result(), content: 'x'.repeat(200001) },
		{ ...result(), summary: 'x'.repeat(2001) },
		{ ...result(), conflicts: Array(31).fill(result().conflicts[0]) },
		{ ...result(), conflicts: [null] },
		{ ...result(), conflicts: [{ topic: '주기', existing: '7일', incoming: '3일' }] }
	])
		assert.equal(validMergeResult(invalid), false);
	for (const key of ['topic', 'previous', 'incoming'])
		for (const value of ['', ' ', 3, 'x'.repeat(3001)]) {
			const invalid = result();
			invalid.conflicts[0][key] = value;
			assert.equal(validMergeResult(invalid), false);
		}
});

test('malformed legacy draft aliases do not break loading or invent candidates', () => {
	const documents = [{ title: '다른 문서', slug: 'different', aliases: [] }];
	for (const aliases of [null, { invalid: true }, 123, [null, 123]])
		assert.equal(mergeCandidates({ title: '기존 초안', aliases }, documents)[0].matched, false);
});
