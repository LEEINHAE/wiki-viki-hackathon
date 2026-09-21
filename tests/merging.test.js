import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingDocuments, validateMerge, mergeRevisionSummary } from '../src/lib/merging.js';
import { draftFingerprint } from '../src/lib/server/draft-publishing.js';

test('merge candidates match normalized titles, draft aliases and existing redirects without substring matches', () => {
	const documents = [
		{ id: '1', title: '공용 장비', slug: '공용-장비' },
		{ id: '2', title: '장비 관리', slug: '장비-관리' },
		{ id: '3', title: '공용 장비 점검표', slug: '공용-장비-점검표' }
	];
	assert.deepEqual(
		matchingDocuments({ title: ' 공용 장비 ', aliases: ['비품'] }, documents, [
			{ alias_slug: '비품', document_id: 2 }
		]).map((doc) => doc.id),
		['1', '2']
	);
	assert.deepEqual(matchingDocuments({ title: '새로운 주제' }, documents), []);
});

test('merge output requires complete content and a separately recorded old/new value for every conflict', () => {
	const result = {
		content: ' 점검 주기는 3일입니다. ',
		summary: '점검 주기를 변경했습니다.',
		conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }]
	};
	assert.equal(validateMerge(result).content, '점검 주기는 3일입니다.');
	assert.throws(() =>
		validateMerge({ ...result, conflicts: [{ topic: '점검 주기', incoming: '3일' }] })
	);
	assert.throws(() => validateMerge({ ...result, content: '' }));
	assert.throws(() => validateMerge({ ...result, conflicts: null }));
	assert.deepEqual(validateMerge({ ...result, conflicts: [] }).conflicts, []);
	const summary = mergeRevisionSummary(
		{ id: 12, title: '공용 장비', source_name: '점검표.xlsx' },
		result,
		'검토자가 수정한 본문'
	);
	assert.match(summary, /AI 통합 · 새 초안 우선/);
	assert.match(summary, /점검표.xlsx/);
	assert.match(summary, /기존: 7일\n새 초안: 3일/);
	assert.match(summary, /검토자가 AI 통합 본문을 추가 수정/);
});

test('draft fingerprint invalidates a merge for source edits but survives storing its proposal', () => {
	const draft = {
		title: '장비',
		slug: '장비',
		content: '초안',
		aliases: ['비품'],
		source_name: '점검표.xlsx',
		editor_handle: 'Editor-99'
	};
	const hash = draftFingerprint(draft);
	assert.equal(
		draftFingerprint({ ...draft, governance: { merge: {} }, updated_at: 'later' }),
		hash
	);
	for (const field of ['title', 'slug', 'content', 'source_name', 'editor_handle'])
		assert.notEqual(draftFingerprint({ ...draft, [field]: '변경됨' }), hash);
	assert.notEqual(draftFingerprint({ ...draft, aliases: [] }), hash);
});
