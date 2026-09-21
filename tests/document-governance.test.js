import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

let server;
let inspect;
let inspectDiscussion;
before(async () => {
	server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, ws: false, watch: null },
		resolve: { alias: { $lib: fileURLToPath(new URL('../src/lib', import.meta.url)) } },
		plugins: [
			{
				name: 'no-private-environment',
				resolveId(id) {
					if (id === '$env/dynamic/private') return '\0test-empty-env';
				},
				load(id) {
					if (id === '\0test-empty-env') return 'export const env = {};';
				}
			}
		]
	});
	({ inspectDocumentContent: inspect, inspectDiscussionContent: inspectDiscussion } =
		await server.ssrLoadModule('/src/lib/server/document-governance.js'));
});

test('discussion topics and bodies share local blocking with field-specific labels', async () => {
	for (const [field, label, text] of [
		['title', '주제', '900101-1000000 점검'],
		['body', '의견', 'password=NotARealSecret42!']
	]) {
		const result = await inspectDiscussion({
			title: '점검 주기',
			body: '점검을 제안합니다.',
			[field]: text
		});
		assert.equal(result.passed, false);
		assert.equal(result.semantic.skipped, true);
		assert.ok(result.fields.some((failure) => failure.field === field && failure.label === label));
	}
});

test('safe discussion review reports skipped semantics without an AI key', async () => {
	const result = await inspectDiscussion({ title: '점검 주기', body: '점검을 제안합니다.' });
	assert.equal(result.passed, true);
	assert.equal(result.semantic.skipped, true);
});
after(async () => server?.close());

test('document governance blocks sensitive titles, content, aliases and summaries even without an AI key', async () => {
	for (const [field, value] of [
		['title', '900101-1000000 장비'],
		['content', 'password=NotARealSecret42!'],
		['aliases', ['900101-1000000']],
		['summary', 'password=NotARealSecret42! 변경 기록'],
		['aliases', { invalid: true }]
	]) {
		const result = await inspect({
			title: '장비 점검',
			content: '점검 기록',
			aliases: [],
			[field]: value
		});
		assert.equal(result.passed, false);
		assert.equal(result.semantic.skipped, true);
		assert.ok(result.fields.some((failure) => failure.field === field));
	}
});

test('safe local review distinguishes skipped semantics from a completed semantic check', async () => {
	const result = await inspect({
		title: '장비 점검',
		content: '점검 기록',
		aliases: ['Equipment, Inspection']
	});
	assert.equal(result.passed, true);
	assert.equal(result.regex.passed, true);
	assert.equal(result.semantic.skipped, true);
	assert.deepEqual(result.fields, []);
});

test('names, HR information and contacts do not re-block review or discussion fields', async () => {
	const text =
		'인사정보 홍길동 / 사번: demo42 / 급여 5000만원 / test.user@example.invalid / 010-0000-0000';
	const document = await inspect({
		title: '대외비 급여 안내',
		content: text,
		aliases: ['인사정보', 'test.user@example.invalid'],
		summary: '연봉 정보 갱신'
	});
	assert.equal(document.passed, true);
	assert.deepEqual(document.fields, []);
	assert.equal(
		(await inspectDiscussion({ title: 'confidential 내부 검토', body: text })).passed,
		true
	);
});
