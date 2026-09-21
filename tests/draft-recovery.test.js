import test from 'node:test';
import assert from 'node:assert/strict';
import {
	draftValues,
	draftInputPending,
	draftRecoveryStore as store,
	validRecoveryDraftId,
	semanticRejected
} from '../src/lib/draft-recovery.js';
import { editRecoveryStore, editValues, recoveryLifetime } from '../src/lib/edit-recovery.js';
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = Date.now(),
	scope = '9007199254740993';
const data = {
	selected: {
		id: scope,
		version: 'a'.repeat(64),
		title: '검토 초안',
		content: '저장 본문',
		aliases: ['쉼표, 별칭', '다른 별칭'],
		editor_handle: 'Editor-01',
		source_name: '검증 자료.docx',
		governance: { merge: { id: first } }
	},
	proposal: {
		id: first,
		targetId: '1012345678',
		targetFingerprint: 'b'.repeat(64),
		content: '최종 통합 원안'
	}
};
const values = draftValues(data, {
	content: '작성 중\n\n본문',
	finalContent: '최종 편집\n\n보존',
	mergeEditor: 'Editor-77'
});
function memory() {
	const entries = new Map();
	return {
		get length() {
			return entries.size;
		},
		key: (i) => [...entries.keys()][i] ?? null,
		getItem: (k) => entries.get(k) ?? null,
		setItem: (k, v) => entries.set(k, String(v)),
		removeItem: (k) => entries.delete(k)
	};
}
test('draft recovery preserves all original versions and final edits without restoring approvals or image permissions', () => {
	const storage = memory();
	store.write(
		storage,
		scope,
		first,
		{
			...values,
			confirmDelete: 'yes',
			confirmMerge: 'yes',
			confirmResetMerge: 'yes',
			showImages: true,
			imagePermission: 'permission from an earlier preview'
		},
		now
	);
	assert.deepEqual(store.read(storage, scope, now).copies[0].values, values);
	assert.equal(values.id, scope);
	assert.equal(values.proposalId, first);
	assert.equal(values.target, '1012345678:' + 'b'.repeat(64));
	assert.equal(values.version, 'a'.repeat(64));
	assert.equal(
		store.sameValues(values, { ...values, target: '1012345678:' + 'c'.repeat(64) }),
		false
	);
	assert.equal(
		store.sameValues(values, {
			...values,
			finalContent: values.finalContent.replaceAll('\n', '\r\n')
		}),
		true
	);
	assert.equal(draftInputPending(draftValues(data), data.selected), false);
	assert.equal(draftInputPending(values, data.selected), true);
	assert.equal(
		draftInputPending({ ...draftValues(data), finalContent: '다른 최종 입력' }, data.selected),
		false
	);
});
test('missing/changed proposals and failures keep explicit submitted values, including empty ones', () => {
	assert.equal(draftValues({ ...data, proposal: null }, values).finalContent, values.finalContent);
	assert.deepEqual(draftValues({ selected: null }, { ...values, title: '', finalContent: '' }), {
		...values,
		title: '',
		finalContent: '',
		sourceName: ''
	});
	assert.equal(draftValues({ selected: null }, null, scope).id, scope);
	assert.equal(draftValues({ ...data, proposal: { invalid: true } }).finalContent, '');
});
test('draft scope must be exact BIGINT; text protection never inspects machine IDs or hashes', () => {
	for (const id of ['0', '-1', '01', '9223372036854775808', '', 'not-id'])
		assert.equal(validRecoveryDraftId(id), false);
	assert.equal(validRecoveryDraftId('9223372036854775807'), true);
	const storage = memory();
	assert.equal(store.write(storage, '2', first, values, now), null);
	assert.equal(storage.length, 0);
	assert.equal(
		store.safe('1012345678', {
			...values,
			version: '01012345678',
			proposalId: 'a0101234-5678-4abc-8abc-abcdefabcdef'
		}),
		true
	);
	for (const field of [
		'title',
		'content',
		'aliases',
		'editor',
		'finalContent',
		'mergeEditor',
		'sourceName'
	]) {
		store.write(storage, scope, first, values, now);
		assert.equal(
			store.write(storage, scope, first, { ...values, [field]: '900101-1000000' }, now),
			null
		);
		assert.equal(storage.length, 0);
	}
});
test('draft copies are independent from existing direct edit schema and other drafts/tabs', () => {
	const storage = memory();
	const edit = editValues({ slug: '기존-문서', version: 'new' });
	editRecoveryStore.write(storage, '기존-문서', first, edit, now);
	const original = storage.getItem(editRecoveryStore.key('기존-문서', first));
	store.write(storage, scope, first, values, now);
	store.write(storage, scope, second, { ...values, finalContent: '다른 탭' }, now);
	store.write(storage, '2', first, { ...values, id: '2' }, now);
	store.remove(storage, scope, first);
	assert.equal(store.read(storage, scope, now).copies[0].values.finalContent, '다른 탭');
	assert.equal(store.read(storage, '2', now).copies.length, 1);
	assert.equal(storage.getItem(editRecoveryStore.key('기존-문서', first)), original);
	assert.deepEqual(editRecoveryStore.read(storage, '기존-문서', now).copies[0].values, edit);
});
test('expiry and malformed cross-draft records never silently recover or corrupt user work', () => {
	const storage = memory();
	const record = store.write(storage, scope, first, values, now);
	storage.setItem('unrelated', 'preserve');
	storage.setItem(
		store.key(scope, second),
		JSON.stringify({ ...record, id: second, values: { ...values, id: '2' } })
	);
	assert.equal(store.read(storage, scope, now).invalid, true);
	assert.equal(store.read(storage, scope, now).copies.length, 1);
	assert.equal(store.read(storage, scope, now + recoveryLifetime).copies.length, 0);
	assert.equal(storage.length, 2);
	assert.equal(storage.getItem('unrelated'), 'preserve');
});
test('quota/access failures preserve complete previous draft and propagate to the UI', () => {
	const storage = memory();
	store.write(storage, scope, first, values, now);
	const previous = storage.getItem(store.key(scope, first));
	storage.setItem = () => {
		throw new Error('quota');
	};
	assert.throws(
		() => store.write(storage, scope, first, { ...values, finalContent: '후속' }, now + 1),
		/quota/
	);
	assert.equal(storage.getItem(store.key(scope, first)), previous);
	storage.getItem = () => {
		throw new Error('denied');
	};
	assert.throws(() => store.read(storage, scope, now), /denied/);
});
test('actual semantic rejection purges matching original and current copies, not other edits', () => {
	const storage = memory();
	store.write(storage, scope, first, values, now);
	store.write(storage, scope, second, { ...values, finalContent: '다른 작업' }, now);
	store.removeRejected(storage, scope, {
		...values,
		mergeEditor: 'Editor-88',
		content: values.content.replaceAll('\n', '\r\n')
	});
	assert.equal(store.read(storage, scope, now).copies[0].values.finalContent, '다른 작업');
	assert.equal(store.read(storage, scope, now).copies.length, 1);
	assert.equal(semanticRejected({ semantic: { passed: false } }), true);
	assert.equal(!!semanticRejected({ semantic: { passed: false, skipped: true } }), false);
	assert.equal(!!semanticRejected({ semantic: { passed: false, unavailable: true } }), false);
});
