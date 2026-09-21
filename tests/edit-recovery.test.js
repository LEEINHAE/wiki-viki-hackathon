import test from 'node:test';
import assert from 'node:assert/strict';
import {
	editValues,
	copyEditValues,
	sameEditValues,
	recoveryKey,
	recoveryPrefix,
	recoveryLifetime,
	recoverySafe,
	readRecoveries,
	writeRecovery,
	removeRecovery,
	removeRejectedRecoveries
} from '../src/lib/edit-recovery.js';
import { regexGovernance as serverGuard } from '../src/lib/server/governance.js';
import { regexGovernance as browserGuard } from '../src/lib/content-guard.js';
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const time = 1700000000000;
const values = editValues(
	{
		slug: '검증-문서',
		document: { id: '9007199254740993', title: '검증 문서', content: '초기 본문' },
		aliases: '쉼표, 별칭\n다른 별칭',
		version: 'a'.repeat(64)
	},
	{ content: '작성 중\n\n[[다른 문서]]', summary: '검토 요약', editor: 'Editor-77' }
);
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
test('recovery preserves every input and original review token without numeric ID loss', () => {
	const storage = memory();
	const record = writeRecovery(
		storage,
		'검증-문서',
		first,
		{ ...values, secret: 'not an edit field' },
		time
	);
	assert.deepEqual(readRecoveries(storage, '검증-문서', time).copies[0].values, values);
	assert.equal(record.values.documentId, '9007199254740993');
	assert.equal(record.expiresAt, time + recoveryLifetime);
	assert.equal(Object.hasOwn(record.values, 'secret'), false);
	assert.deepEqual(copyEditValues(values), values);
	assert.equal(
		sameEditValues(values, { ...values, content: values.content.replaceAll('\n', '\r\n') }),
		true
	);
	assert.equal(sameEditValues(values, { ...values, version: 'b'.repeat(64) }), false);
	assert.equal(sameEditValues(values, { ...values, content: values.content + ' ' }), false);
	assert.equal(editValues({ slug: '새-문서', version: 'new' }).version, 'new');
});
test('24-hour expiry removes only owned expired copies, including other routes', () => {
	const storage = memory();
	storage.setItem('wiki-theme', 'dark');
	storage.setItem('unrelated-user-work', 'preserve');
	writeRecovery(storage, '검증-문서', first, values, time);
	writeRecovery(storage, '다른-문서', second, values, time + 1);
	assert.equal(readRecoveries(storage, '검증-문서', time + recoveryLifetime - 1).copies.length, 1);
	assert.equal(readRecoveries(storage, '검증-문서', time + recoveryLifetime).copies.length, 0);
	assert.equal(storage.getItem(recoveryKey('다른-문서', second)) !== null, true);
	readRecoveries(storage, '검증-문서', time + recoveryLifetime + 1);
	assert.equal(storage.length, 2);
	assert.equal(storage.getItem('unrelated-user-work'), 'preserve');
});
test('separate tabs and routes never overwrite each other; removal is exact', () => {
	const storage = memory();
	writeRecovery(storage, '검증-문서', first, values, time);
	writeRecovery(storage, '검증-문서', second, { ...values, content: '다른 탭' }, time + 1);
	writeRecovery(storage, '다른-문서', first, { ...values, content: '다른 경로' }, time + 2);
	writeRecovery(storage, '검증-문서', first, { ...values, content: '첫 탭 후속 입력' }, time + 3);
	assert.deepEqual(
		readRecoveries(storage, '검증-문서', time + 4).copies.map((c) => c.values.content),
		['첫 탭 후속 입력', '다른 탭']
	);
	removeRecovery(storage, '검증-문서', first);
	assert.equal(readRecoveries(storage, '검증-문서', time + 4).copies[0].values.content, '다른 탭');
	assert.equal(
		readRecoveries(storage, '다른-문서', time + 4).copies[0].values.content,
		'다른 경로'
	);
});
test('shared local guard blocks every input field and route without external calls', () => {
	assert.equal(serverGuard, browserGuard);
	for (const field of ['title', 'content', 'aliases', 'editor', 'summary']) {
		const storage = memory();
		writeRecovery(storage, '검증-문서', first, values, time);
		const unsafe = { ...values, [field]: '900101-1000000' };
		assert.equal(recoverySafe('검증-문서', unsafe), false);
		assert.equal(writeRecovery(storage, '검증-문서', first, unsafe, time + 1), null);
		assert.equal(storage.length, 0);
	}
	assert.equal(recoverySafe('900101-1000000', values), false);
	// Guard only user text, never a review hash resembling a telephone number.
	assert.equal(recoverySafe('검증-문서', { ...values, version: '01012345678' }), true);
	const storage = memory(),
		record = writeRecovery(storage, '검증-문서', first, values, time);
	record.values.content = '개인 900101-1000000';
	storage.setItem(recoveryKey('검증-문서', first), JSON.stringify(record));
	assert.equal(readRecoveries(storage, '검증-문서', time).purged, true);
	assert.equal(storage.length, 0);
});
test('malformed or mismatched records are reported and never restored or destroyed', () => {
	const storage = memory();
	const key = recoveryKey('검증-문서', first);
	storage.setItem(key, '{');
	storage.setItem(recoveryPrefix + 'unknown', '{"schemaVersion":5}');
	const result = readRecoveries(storage, '검증-문서', time);
	assert.deepEqual(result.copies, []);
	assert.equal(result.invalid, true);
	assert.equal(storage.length, 2);
	const record = writeRecovery(storage, '다른-문서', second, values, time);
	storage.setItem(key, JSON.stringify(record));
	assert.equal(readRecoveries(storage, '검증-문서', time).copies.length, 0);
	assert.notEqual(storage.getItem(key), null);
});
test('storage access and quota failures surface while the previous complete copy survives', () => {
	const storage = memory();
	writeRecovery(storage, '검증-문서', first, values, time);
	const before = storage.getItem(recoveryKey('검증-문서', first));
	storage.setItem = () => {
		throw new Error('QuotaExceededError');
	};
	assert.throws(
		() => writeRecovery(storage, '검증-문서', first, { ...values, content: '다음 입력' }, time + 1),
		/QuotaExceededError/
	);
	assert.equal(storage.getItem(recoveryKey('검증-문서', first)), before);
	storage.getItem = () => {
		throw new Error('SecurityError');
	};
	assert.throws(() => readRecoveries(storage, '검증-문서', time), /SecurityError/);
});

test('semantic rejection removes matching restored copies without deleting different work', () => {
	const storage = memory(),
		now = Date.now();
	writeRecovery(storage, '검증-문서', first, values, now);
	writeRecovery(storage, '검증-문서', second, { ...values, content: '다른 탭의 별도 입력' }, now);
	writeRecovery(storage, '다른-문서', first, values, now);
	removeRejectedRecoveries(storage, '검증-문서', {
		...values,
		editor: 'Editor-88',
		content: values.content.replaceAll('\n', '\r\n')
	});
	assert.equal(readRecoveries(storage, '검증-문서', now).copies.length, 1);
	assert.equal(
		readRecoveries(storage, '검증-문서', now).copies[0].values.content,
		'다른 탭의 별도 입력'
	);
	assert.equal(readRecoveries(storage, '다른-문서', now).copies.length, 1);
});
