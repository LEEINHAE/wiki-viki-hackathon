import test from 'node:test';
import assert from 'node:assert/strict';
import { readUploadResponse } from '../src/lib/upload.js';

const result = {
	drafts: [{ id: '9007199254740993', title: '인계 노트', status: 'review', linkCount: 0 }],
	count: 1,
	aiGenerated: true,
	semanticSkipped: false
};

test('upload response retains actual draft IDs and server rejection messages', async () => {
	assert.deepEqual(await readUploadResponse(Response.json(result, { status: 201 })), result);
	await assert.rejects(
		readUploadResponse(Response.json({ message: '파일을 읽을 수 없습니다.' }, { status: 422 })),
		{ message: '파일을 읽을 수 없습니다.' }
	);
});

test('all 32 fine-grained drafts are shown without treating a saved batch as an upload failure', async () => {
	const drafts = Array.from({ length: 32 }, (_, i) => ({
		...result.drafts[0],
		id: String(i + 1),
		title: `세부 작업 ${i + 1}`
	}));
	const payload = { ...result, drafts, count: drafts.length };
	assert.deepEqual(await readUploadResponse(Response.json(payload, { status: 201 })), payload);
	await assert.rejects(
		readUploadResponse(
			Response.json({ ...payload, drafts: [...drafts, { ...drafts[0], id: '33' }], count: 33 })
		),
		/초안 검토 목록/
	);
});

test('non-JSON upload failures provide actionable messages without exposing response bodies', async () => {
	for (const [status, message] of [
		[413, /서버의 용량 제한/],
		[504, /초안 검토 목록/],
		[502, /초안 검토 목록/]
	]) {
		await assert.rejects(
			readUploadResponse(new Response('<html>internal proxy error</html>', { status })),
			(error) => message.test(error.message) && !/internal|JSON|Unexpected/.test(error.message)
		);
	}
});

test('incomplete success payloads cannot crash the upload result view or imply confirmed success', async () => {
	for (const payload of [
		null,
		{},
		{ ...result, drafts: null },
		{ ...result, count: 2 },
		{ ...result, drafts: [null] },
		{ ...result, drafts: [{ ...result.drafts[0], id: '../other' }] },
		{ ...result, drafts: [{ ...result.drafts[0], title: '' }] },
		{ ...result, drafts: [{ ...result.drafts[0], status: 'published' }] },
		{ ...result, drafts: [{ ...result.drafts[0], linkCount: -1 }] }
	]) {
		await assert.rejects(readUploadResponse(Response.json(payload)), /초안 검토 목록/);
	}
	await assert.rejects(readUploadResponse(new Response('not JSON')), /초안 검토 목록/);
});
