import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFingerprint, mergeInput, validateMerge } from '../src/lib/server/merge-contract.js';

test('merge validates draft fingerprint, source safety, instruction boundary and output limits', () => {
	const draft = {
		title: '검증 문서',
		slug: '검증-문서',
		content: '점검 주기는 3일입니다.',
		aliases: [],
		source_name: '검증 자료',
		editor_handle: 'Editor-01'
	};
	assert.notEqual(draftFingerprint(draft), draftFingerprint({ ...draft, aliases: ['별칭'] }));
	assert.notEqual(draftFingerprint(draft), draftFingerprint({ ...draft, content: '다른 본문' }));
	const input = mergeInput(
		{ title: '기존 문서', content: '점검 주기는 7일, 파란 보관함에 보관합니다.' },
		draft
	);
	assert.equal(input[0].role, 'system');
	assert.match(input[0].content, /새 초안을 우선/);
	assert.throws(() => mergeInput({ title: '대외비', content: '본문' }, draft), /콘텐츠 보호/);
	const sample = {
		content: '점검 주기는 3일입니다. 파란 보관함에 보관합니다.',
		summary: '주기 변경',
		conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }]
	};
	assert.deepEqual(validateMerge(sample), sample);
	assert.throws(
		() => validateMerge({ ...sample, conflicts: [{ topic: '주기', previous: '7일' }] }),
		/invalid_merge/
	);
	assert.throws(() => validateMerge({ ...sample, content: 'x'.repeat(200001) }), /invalid_merge/);
	assert.throws(
		() => validateMerge({ ...sample, content: '연락처 person@example.com' }),
		/콘텐츠 보호/
	);
});
