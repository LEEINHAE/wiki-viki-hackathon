import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

let server;
let POST;
let load;
let ai;
let state;
const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/answer-server.js', import.meta.url));
const safeDocuments = [
	{ id: 1, title: '장비 점검', slug: '장비-점검', content: '장비 상태를 확인합니다.' },
	{
		id: 2,
		title: '장비 인계',
		slug: '장비-인계',
		content: '장비 상태를 다음 근무자에게 전달합니다.'
	}
];
const answer = {
	title: '장비 점검과 인계',
	insufficient: false,
	paragraphs: [{ text: '장비 상태를 확인하고 전달합니다.', sourceIds: [1, 2] }]
};

before(async () => {
	server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, ws: false, watch: null },
		resolve: { alias: { $lib: lib } },
		plugins: [
			{
				name: 'isolated-answer-dependencies',
				enforce: 'pre',
				resolveId(id) {
					if (id === '$env/dynamic/private' || id === `${lib}/server/db.js`) return fixture;
					if (id === './db.js') return fixture;
				}
			}
		]
	});
	state = await server.ssrLoadModule(fixture);
	({ POST } = await server.ssrLoadModule('/src/routes/api/answer/+server.js'));
	({ load } = await server.ssrLoadModule('/src/routes/+page.server.js'));
	ai = await server.ssrLoadModule('/src/lib/server/openai.js');
});

after(async () => server?.close());
beforeEach(() => {
	state.env.OPENAI_API_KEY = 'test-only-key';
	state.database.calls.length = 0;
	state.database.fail = false;
	state.database.documents = safeDocuments.map((document) => ({
		...document,
		editor_handle: 'Editor-01',
		updated_at: '2026-09-21T00:00:00Z'
	}));
});

function interceptAI(t, { value = answer, httpStatus, status = 'completed' } = {}) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (_url, options) => {
		calls.push(JSON.parse(options.body));
		if (httpStatus)
			return Response.json({ error: { message: 'Synthetic AI failure' } }, { status: httpStatus });
		return Response.json({
			object: 'response',
			status,
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }]
				}
			]
		});
	});
	return calls;
}

function ask(q = '장비') {
	return POST({
		request: new Request('http://localhost/api/answer', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ q })
		})
	});
}

test('blocked questions stop before database lookup even when the database is unavailable', async (t) => {
	const calls = interceptAI(t);
	state.database.fail = true;
	for (const query of [
		'900101-1000000 장비',
		'900101-1000000',
		'password=NotARealSecret42!',
		'access_token=NotARealSecret42!'
	]) {
		const response = await ask(query);
		assert.equal(response.status, 422);
		const result = await response.json();
		assert.equal(result.status, 'blocked');
		assert.match(result.message, /원문/);
		assert.ok(!result.message.includes(query));
	}
	assert.equal(state.database.calls.length, 0);
	assert.equal(calls.length, 0);
});

test('direct answer calls cannot bypass blocked-question checks or report them as empty', async (t) => {
	const calls = interceptAI(t);
	for (const documents of [[], safeDocuments]) {
		await assert.rejects(ai.answerQuestion('900101-1000000 장비', documents), {
			name: 'ContentBlockedError'
		});
	}
	assert.equal(calls.length, 0);
});

test('the full source title and content are checked before excerpt selection and safe sources stay aligned', async (t) => {
	const calls = interceptAI(t);
	state.database.documents = [
		{ id: 3, title: '900101-1000000 장비', slug: 'blocked-title', content: '장비 설명' },
		{
			id: 4,
			title: '장비 기록',
			slug: 'blocked-content',
			content: '장비 설명\n\n'.repeat(1500) + '900101-1000000'
		},
		...state.database.documents
	];
	const result = await (await ask()).json();
	assert.equal(result.status, 'complete');
	assert.equal(calls.length, 1);
	const sent = JSON.parse(calls[0].input);
	assert.deepEqual(
		sent.documents.map(({ title, sourceId }) => ({ title, sourceId })),
		[
			{ title: '장비 점검', sourceId: 1 },
			{ title: '장비 인계', sourceId: 2 }
		]
	);
	assert.doesNotMatch(calls[0].input, /900101-1000000|900101-1000000|blocked-content/);
	assert.deepEqual(
		result.sources.map(({ slug }) => slug),
		['장비-점검', '장비-인계']
	);
	assert.equal(calls[0].store, false);
	assert.equal(state.database.calls[0].values.at(-1), 6);
});

test('all blocked evidence yields a blocked state without an AI call', async (t) => {
	const calls = interceptAI(t);
	state.database.documents = [
		{ id: 3, title: '900101-1000000 장비', slug: 'blocked', content: '장비 설명' }
	];
	const response = await ask();
	assert.equal(response.status, 422);
	assert.equal((await response.json()).status, 'blocked');
	assert.equal(calls.length, 0);
});

test('ordinary search results survive content blocking without external AI calls', async (t) => {
	const calls = interceptAI(t);
	state.database.documents[0].content = '900101-1000000 장비 설명';
	const result = await load({ url: new URL('http://localhost/?q=900101-1000000') });
	assert.equal(result.databaseReady, true);
	assert.equal(result.results.length, 2);
	assert.equal(result.results[0].slug, '장비-점검');
	assert.equal((await ask('900101-1000000')).status, 422);
	assert.equal(calls.length, 0);
});

test('missing key and empty evidence retain distinct fallback states without external calls', async (t) => {
	const calls = interceptAI(t);
	state.env.OPENAI_API_KEY = '';
	let response = await ask();
	assert.equal(response.status, 200);
	assert.equal((await response.json()).status, 'unavailable');
	assert.equal((await load({ url: new URL('http://localhost/?q=장비') })).results.length, 2);
	state.database.documents = [];
	response = await ask();
	assert.equal(response.status, 200);
	assert.equal((await response.json()).status, 'empty');
	assert.equal(calls.length, 0);
});

test('AI quota failure keeps the ordinary search and retryable status without fake answers', async (t) => {
	const calls = interceptAI(t, { httpStatus: 429 });
	const response = await ask();
	assert.equal(response.status, 503);
	const result = await response.json();
	assert.equal(result.status, 'unavailable');
	assert.equal(result.paragraphs, undefined);
	assert.equal(calls.length, 1);
	assert.equal((await load({ url: new URL('http://localhost/?q=장비') })).results.length, 2);
});

test('fabricated citations never reference excluded source documents', async (t) => {
	interceptAI(t, {
		value: { ...answer, paragraphs: [{ text: '근거 없는 답변', sourceIds: [99] }] }
	});
	const result = await (await ask()).json();
	assert.equal(result.status, 'insufficient');
	assert.equal(result.sources, undefined);
});
