import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { presentationFile } from './fixtures/office.js';
import { blockedTopicCases } from './fixtures/governance-topics.js';

let server;
let POST;
let ai;
let state;
const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/wikify-server.js', import.meta.url));

before(async () => {
	server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, ws: false, watch: null },
		resolve: { alias: { $lib: lib } },
		plugins: [
			{
				name: 'isolated-wikify-dependencies',
				enforce: 'pre',
				resolveId(id) {
					if (id === '$env/dynamic/private' || id === `${lib}/server/db.js`) return fixture;
					if (id === './db.js') return fixture;
				}
			}
		]
	});
	state = await server.ssrLoadModule(fixture);
	({ POST } = await server.ssrLoadModule('/src/routes/api/wikify/+server.js'));
	ai = await server.ssrLoadModule('/src/lib/server/openai.js');
});

after(async () => server?.close());
beforeEach(() => {
	state.env.OPENAI_API_KEY = 'test-only-key';
	delete state.env.OPENAI_MODEL;
	state.database.calls = 0;
	state.database.drafts.length = 0;
});

for (const model of [undefined, 'gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-4.1-mini'])
	test(`wikify uses bounded reasoning for GPT-5 mini while preserving model selection (${model})`, async (t) => {
		state.env.OPENAI_MODEL = model;
		const calls = interceptAI(t, [
			{ value: { passed: true, reasons: [] } },
			{ value: { topics: [{ title: generated.documents[0].title, scope: '장비 상태 확인' }] } },
			{ value: generated }
		]);
		assert.equal((await upload()).status, 201);
		for (const call of calls.slice(1)) {
			assert.equal(call.model, model || 'gpt-5-mini');
			assert.deepEqual(call.reasoning, model === 'gpt-4.1-mini' ? undefined : { effort: 'low' });
		}
		assert.equal(calls[0].reasoning, undefined);
	});

test('a generation deadline cancels pending batches, saves nothing and reports a retryable timeout', async (t) => {
	const deadline = new AbortController();
	t.mock.method(AbortSignal, 'timeout', (ms) => {
		assert.equal(ms, 90000);
		return deadline.signal;
	});
	const topics = Array.from({ length: 32 }, (_, index) => ({
		title: `가상 약어 ${index + 1}`,
		scope: '해당 약어의 원문 정의'
	}));
	let batches = 0;
	let cancelled = 0;
	let started;
	const ready = new Promise((resolve) => (started = resolve));
	interceptAI(t, async (request, options) => {
		if (!request.text?.format) return { value: { passed: true, reasons: [] } };
		if (request.text.format.name === 'wiki_document_topics') return { value: { topics } };
		batches++;
		if (batches === 4) started();
		if (batches < 4)
			return {
				value: {
					documents: JSON.parse(request.input).topics.map(({ title }) => ({
						...generated.documents[0],
						title
					}))
				}
			};
		return new Promise((_resolve, reject) => {
			options.signal.addEventListener(
				'abort',
				() => {
					cancelled++;
					reject(options.signal.reason);
				},
				{ once: true }
			);
		});
	});
	const pending = upload();
	await ready;
	deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
	const response = await pending;
	assert.equal(response.status, 504);
	assert.match((await response.json()).message, /시간.*초과/);
	assert.equal(cancelled, 1);
	assert.equal(state.database.calls, 0);
	assert.equal(state.database.drafts.length, 0);
});

function interceptAI(t, results = []) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (_url, options) => {
		calls.push(JSON.parse(options.body));
		const next = await (typeof results === 'function'
			? results(calls.at(-1), options)
			: results[calls.length - 1]);
		assert.ok(next, 'Unexpected outbound request');
		if (next.httpStatus)
			return Response.json(
				{ error: { message: 'Test service failure' } },
				{ status: next.httpStatus }
			);
		return Response.json({
			object: 'response',
			status: next.status || 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [
						{ type: 'output_text', text: next.raw ?? JSON.stringify(next.value), annotations: [] }
					]
				}
			]
		});
	});
	return calls;
}

async function upload({ text, name = 'verification.pptx' } = {}) {
	const original = await presentationFile();
	const zip = await JSZip.loadAsync(await original.arrayBuffer());
	if (text) {
		const path = 'ppt/slides/slide10.xml';
		zip.file(path, (await zip.file(path).async('string')).replace('인계 ', text));
	}
	const form = new FormData();
	form.set('file', new File([await zip.generateAsync({ type: 'nodebuffer' })], name));
	form.set('editor', 'Editor-01');
	return POST({
		request: new Request('http://localhost/api/wikify', { method: 'POST', body: form })
	});
}

const generated = {
	documents: [
		{
			title: '장비 점검',
			sections: [{ heading: '절차', content: '장비 상태를 확인합니다.' }],
			suggestedLinks: [],
			aliases: []
		}
	]
};

for (const withKey of [false, true])
	test(`ordinary confidential/HR/contact uploads are allowed (AI key=${withKey})`, async (t) => {
		state.env.OPENAI_API_KEY = withKey ? 'test-only-key' : '';
		const text =
			'대외비 인사정보 급여 연봉 안내: 홍길동, 사번: demo42, test.user@example.invalid, 010-0000-0000 ';
		const calls = interceptAI(t, [
			{ value: { passed: true, reasons: [] } },
			{ value: { topics: [{ title: '급여 안내', scope: '급여 담당자와 연락처 안내' }] } },
			{
				value: {
					documents: [
						{
							...generated.documents[0],
							title: '급여 안내',
							sections: [{ heading: '대외비 업무 안내', content: text }],
							aliases: ['인사정보']
						}
					]
				}
			}
		]);
		const response = await upload({ text, name: 'confidential-인사정보-급여.pptx' });
		assert.equal(response.status, 201);
		const result = await response.json();
		assert.equal(result.drafts[0].status, 'review');
		assert.equal(result.semanticSkipped, !withKey);
		assert.equal(calls.length, withKey ? 3 : 0);
		assert.ok(state.database.drafts[0].content.includes('test.user@example.invalid'));
		assert.ok(state.database.drafts[0].content.includes('010-0000-0000'));
		if (withKey) {
			assert.match(calls[0].instructions, /기본 판정은 허용/);
			assert.match(calls[0].instructions, /기밀·대외비·confidential 표기는 허용/);
			assert.match(calls[0].instructions, /명확히 노출된 경우에만 passed=false/);
			assert.match(calls[0].instructions, /애매하면 허용/);
			assert.equal(calls[0].store, false);
		}
	});

test('blocked upload text and filename stop before any AI or database call', async (t) => {
	const calls = interceptAI(t);
	const inputs = [
		{ text: '900101-1000000 ' },
		{ text: '900101-1000000 ' },
		{ text: 'password=NotARealSecret42! ' },
		{ text: '900101-1000000 ' },
		{ text: 'access_token=NotARealSecret42! ' },
		{ text: '900101-1000000 ' },
		{ name: '900101-1000000.pptx' }
	];
	for (const input of inputs) {
		const response = await upload(input);
		assert.equal(response.status, 422);
		assert.match((await response.json()).message, /콘텐츠 보호/);
	}
	assert.equal(calls.length, 0);
	assert.equal(state.database.calls, 0);
});

test('semantic rejection stops generation and returns a safe message without source text', async (t) => {
	const calls = interceptAI(t, [
		{ value: { passed: false, reasons: ['private-source-fragment'] } }
	]);
	const response = await upload();
	assert.equal(response.status, 422);
	const body = await response.json();
	assert.match(body.message, /콘텐츠 보호/);
	assert.doesNotMatch(JSON.stringify(body), /private-source-fragment/);
	assert.equal(calls.length, 1);
	assert.equal(state.database.calls, 0);
});

test('invalid or incomplete semantic results never authorize generation', async (t) => {
	const invalid = [
		{ raw: '{invalid JSON' },
		{ value: null },
		{ value: {} },
		{ value: { passed: 'false', reasons: [] } },
		{ value: { passed: true, reasons: 'invalid' } },
		{ value: { passed: true, reasons: [42] } },
		{ value: { passed: true, reasons: ['contradictory rejection'] } },
		{ value: { passed: true, reasons: [] }, status: 'incomplete' }
	];
	const calls = interceptAI(t, invalid);
	for (let index = 0; index < invalid.length; index += 1) {
		const response = await upload();
		assert.equal(response.status, 503);
		assert.match((await response.json()).message, /검사 결과를 확인하지 못했습니다/);
		assert.equal(calls.length, index + 1);
	}
	assert.equal(state.database.calls, 0);
});

test('semantic service failure does not fall back to generation or database writes', async (t) => {
	const calls = interceptAI(t, [{ httpStatus: 429 }]);
	assert.equal((await upload()).status, 503);
	assert.equal(calls.length, 1);
	assert.equal(state.database.calls, 0);
});

test('generation failure after a passed check does not create a local fallback draft', async (t) => {
	const calls = interceptAI(t, [{ value: { passed: true, reasons: [] } }, { httpStatus: 429 }]);
	assert.equal((await upload()).status, 503);
	assert.equal(calls.length, 2);
	assert.equal(state.database.calls, 0);
});

test('safe upload checks filename and text before generation and retains review status', async (t) => {
	const calls = interceptAI(t, [
		{ value: { passed: true, reasons: [], skipped: true } },
		{ value: { topics: [{ title: '장비 점검', scope: '장비 상태 확인 절차' }] } },
		{ value: generated }
	]);
	const response = await upload();
	assert.equal(response.status, 201);
	const result = await response.json();
	assert.equal(result.aiGenerated, true);
	assert.equal(result.semanticSkipped, false);
	assert.equal(result.count, 1);
	assert.equal(result.drafts[0].status, 'review');
	assert.equal(calls.length, 3);
	assert.match(calls[0].input, /verification.pptx/);
	assert.match(calls[0].input, /다음 근무자/);
	assert.equal(calls[0].store, false);
	assert.equal(state.database.drafts[0].governance.semantic.skipped, false);
});

test('missing key keeps the local draft and explicitly records skipped semantics', async (t) => {
	state.env.OPENAI_API_KEY = '';
	const calls = interceptAI(t);
	const response = await upload();
	assert.equal(response.status, 201);
	const result = await response.json();
	assert.equal(result.aiGenerated, false);
	assert.equal(result.semanticSkipped, true);
	assert.equal(result.count, 1);
	assert.equal(result.drafts[0].status, 'review');
	assert.equal(state.database.drafts[0].governance.semantic.skipped, true);
	assert.equal(calls.length, 0);
	assert.equal((await upload({ text: '900101-1000000 ' })).status, 422);
	assert.equal(state.database.drafts.length, 1);
});

test('AI entry points independently prevent bypassing the local input guard', async (t) => {
	const calls = interceptAI(t);
	const result = await ai.semanticGovernance('900101-1000000 문서');
	assert.equal(result.passed, false);
	await assert.rejects(ai.structureDocuments('900101-1000000 문서', 'verification.pptx'));
	await assert.rejects(ai.structureDocuments('장비 점검', '900101-1000000.pptx'));
	assert.equal(calls.length, 0);
});

const topicPlan = {
	topics: [
		{ title: '교대 인계', scope: '다음 근무자에게 전달할 내용과 순서' },
		{ title: '설비 점검', scope: '인계 전 설비 상태를 확인하는 방법' },
		{ title: '이상 보고', scope: '점검 중 발견한 이상을 보고하는 절차' }
	]
};
const splitDocuments = {
	documents: [
		{
			title: '교대 인계',
			sections: [
				{ heading: '절차', content: '설비 점검 후 다음 근무자에게 운전 상태를 전달합니다.' }
			],
			suggestedLinks: ['설비 점검'],
			aliases: ['근무 인계']
		},
		{
			title: '설비 점검',
			sections: [
				{ heading: '절차', content: '압력계를 확인하고 이상이 있으면 이상 보고를 진행합니다.' }
			],
			suggestedLinks: ['이상 보고'],
			aliases: []
		},
		{
			title: '이상 보고',
			sections: [{ heading: '절차', content: '설비 점검 중 발견한 이상은 당직자에게 보고합니다.' }],
			suggestedLinks: ['설비 점검'],
			aliases: []
		}
	]
};

test('one file becomes one linked draft per planned topic, even when generation returns another order', async (t) => {
	const calls = interceptAI(t, [
		{ value: { passed: true, reasons: [] } },
		{ value: topicPlan },
		{ value: { documents: [...splitDocuments.documents].reverse() } }
	]);
	const response = await upload();
	assert.equal(response.status, 201);
	const result = await response.json();
	assert.equal(result.count, 3);
	assert.deepEqual(
		result.drafts.map((draft) => draft.title),
		topicPlan.topics.map((topic) => topic.title)
	);
	assert.ok(result.drafts.every((draft) => draft.status === 'review' && draft.linkCount === 1));
	assert.equal(calls.length, 3);
	assert.equal(calls[1].text.format.name, 'wiki_document_topics');
	assert.equal(calls[2].text.format.name, 'wiki_documents');
	assert.deepEqual(JSON.parse(calls[2].input).topics, topicPlan.topics);
	assert.equal(JSON.parse(calls[1].input).sourceText, JSON.parse(calls[2].input).sourceText);
	assert.equal(calls[2].text.format.schema.properties.documents.minItems, 3);
	assert.equal(calls[2].text.format.schema.properties.documents.maxItems, 3);
	assert.ok(calls.every((call) => call.store === false));
	assert.match(state.database.drafts[0].content, /\[\[설비 점검\]\]/);
});

test('missing, merged, duplicate, extra or unplanned generated topics cannot be saved', async (t) => {
	const first = splitDocuments.documents[0];
	const invalid = [
		{ documents: [first] },
		{ documents: [first, first, first] },
		{ documents: [...splitDocuments.documents, { ...first, title: '추가 주제' }] },
		{ documents: [first, splitDocuments.documents[1], { ...first, title: '파일 전체 요약' }] },
		{
			documents: [
				first,
				splitDocuments.documents[1],
				{ ...splitDocuments.documents[2], sections: [] }
			]
		}
	];
	const calls = interceptAI(
		t,
		invalid.flatMap((value) => [
			{ value: { passed: true, reasons: [] } },
			{ value: topicPlan },
			{ value }
		])
	);
	for (const _value of invalid) assert.equal((await upload()).status, 500);
	assert.equal(calls.length, invalid.length * 3);
	assert.equal(state.database.calls, 0);
});

test('invalid topic plans stop before writing or requesting document content', async (t) => {
	const invalid = [
		null,
		{},
		{ topics: [] },
		{ topics: [null] },
		{ topics: [{ title: '###', scope: '내용' }] },
		{ topics: [{ title: '설비', scope: '' }] },
		{
			topics: [
				{ title: '설비 점검', scope: '내용' },
				{ title: '설비_점검', scope: '다른 내용' }
			]
		},
		{ topics: Array.from({ length: 33 }, (_, i) => ({ title: `주제 ${i}`, scope: '내용' })) }
	];
	const calls = interceptAI(
		t,
		invalid.flatMap((value) => [{ value: { passed: true, reasons: [] } }, { value }])
	);
	for (const _value of invalid) assert.equal((await upload()).status, 500);
	assert.equal(calls.length, invalid.length * 2);
	assert.equal(state.database.calls, 0);
});

test('topic planning and document generation failures never save partial or fallback drafts', async (t) => {
	const cases = [
		[{ value: topicPlan, status: 'incomplete' }],
		[{ raw: '{broken JSON' }],
		[{ value: topicPlan }, { httpStatus: 429 }],
		[{ value: topicPlan }, { value: splitDocuments, status: 'incomplete' }],
		[{ value: topicPlan }, { raw: '{broken JSON' }]
	];
	const calls = interceptAI(
		t,
		cases.flatMap((results) => [{ value: { passed: true, reasons: [] } }, ...results])
	);
	for (const [index] of cases.entries())
		assert.equal((await upload()).status, index === 2 ? 503 : 500);
	assert.equal(calls.length, 13);
	assert.equal(state.database.calls, 0);
});

test('eight distinct topics are retained without silently truncating the batch', async (t) => {
	const topics = Array.from({ length: 8 }, (_, index) => ({
		title: `업무 ${index + 1}`,
		scope: `업무 ${index + 1}의 절차`
	}));
	interceptAI(t, [
		{ value: { passed: true, reasons: [] } },
		{ value: { topics } },
		{
			value: {
				documents: topics.map((topic) => ({ ...generated.documents[0], title: topic.title }))
			}
		}
	]);
	const response = await upload();
	assert.equal(response.status, 201);
	assert.equal((await response.json()).count, 8);
	assert.equal(state.database.drafts.length, 8);
});

test('generated topic scopes with exposed credentials stop before the second AI call', async (t) => {
	const calls = interceptAI(t, [
		{ value: { passed: true, reasons: [] } },
		{ value: { topics: [{ title: '설비 점검', scope: 'password=NotARealSecret42!' }] } }
	]);
	assert.equal((await upload()).status, 422);
	assert.equal(calls.length, 2);
	assert.equal(state.database.calls, 0);
});

for (const { name, value } of blockedTopicCases)
	for (const field of ['title', 'scope'])
		for (const count of [1, 32])
			test(`topic ${field} with ${name} blocks all generation batches (${count} topics)`, async (t) => {
				const topics = Array.from({ length: count }, (_, index) => ({
					title: `점검 항목 ${index + 1}`,
					scope: '점검 방법과 기록'
				}));
				// The last topic must be checked before even the first batch starts.
				topics.at(-1)[field] = value;
				const calls = interceptAI(t, (request) => ({
					value:
						request.text?.format?.name === 'wiki_document_topics'
							? { topics }
							: request.text?.format?.name === 'wiki_documents'
								? {
										documents: JSON.parse(request.input).topics.map(({ title }) => ({
											...generated.documents[0],
											title
										}))
									}
								: { passed: true, reasons: [] }
				}));
				const response = await upload();
				const result = await response.json();
				assert.equal(response.status, 422);
				assert.match(result.message, /콘텐츠 보호/);
				assert.match(result.message, /AI가 만든 문서 주제/);
				assert.ok(!result.message.includes(value));
				assert.doesNotMatch(result.message, /NotARealSecret42|BEGIN PRIVATE KEY/);
				assert.equal(calls.length, 2, 'Only source inspection and topic planning may run');
				assert.ok(calls.every((request) => !request.input.includes('NotARealSecret42')));
				assert.equal(state.database.calls, 0);
				assert.equal(state.database.drafts.length, 0);
			});

test('topic inspection preserves ordinary details and escaped placeholder documentation', async (t) => {
	const scope =
		'대외비 급여 담당자 test.user@example.invalid\napi_key="YOUR_API_KEY"\npassword:\nYOUR_PASSWORD\n접근 토큰은 환경 변수로 설정합니다.';
	const calls = interceptAI(t, [
		{ value: { passed: true, reasons: [] } },
		{ value: { topics: [{ title: generated.documents[0].title, scope }] } },
		{ value: generated }
	]);
	assert.equal((await upload()).status, 201);
	assert.equal(calls.length, 3);
	assert.equal(JSON.parse(calls[2].input).topics[0].scope, scope);
	assert.equal(state.database.drafts.length, 1);
	assert.equal(state.database.drafts[0].status, 'review');
});

for (const count of [9, 32])
	test(`${count} fine topics survive bounded generation batches and retain cross-batch links`, async (t) => {
		const topics = Array.from({ length: count }, (_, i) => ({
			title: `장비 ${i + 1} 점검`,
			scope: `장비 ${i + 1}의 고유 점검 기준과 조치`
		}));
		const documents = topics.map((topic, i) => ({
			...generated.documents[0],
			title: topic.title,
			sections: [
				{
					heading: '점검',
					content: `장비 상태 확인 후 ${topics[(i + 8) % count].title}을 진행합니다.`
				}
			],
			suggestedLinks: [topics[(i + 8) % count].title]
		}));
		const batches = [];
		for (let i = 0; i < count; i += 8)
			batches.push({ value: { documents: documents.slice(i, i + 8).reverse() } });
		const calls = interceptAI(t, [
			{ value: { passed: true, reasons: [] } },
			{ value: { topics } },
			...batches
		]);
		const response = await upload();
		assert.equal(response.status, 201);
		assert.equal((await response.json()).count, count);
		assert.deepEqual(
			state.database.drafts.map((draft) => draft.title),
			topics.map((topic) => topic.title)
		);
		assert.equal(calls.length, 2 + Math.ceil(count / 8));
		assert.equal(calls[1].text.format.schema.properties.topics.maxItems, 32);
		for (const [index, call] of calls.slice(2).entries()) {
			const input = JSON.parse(call.input);
			assert.deepEqual(input.topics, topics.slice(index * 8, (index + 1) * 8));
			assert.deepEqual(input.relatedTopics, topics);
			assert.equal(call.text.format.schema.properties.documents.maxItems, input.topics.length);
			assert.equal(call.store, false);
		}
		assert.match(state.database.drafts[0].content, /\[\[장비 9 점검\]\]/);
	});

for (const failure of ['incomplete', 'missing', 'wrong-batch'])
	test(`a ${failure} later generation batch cannot save earlier completed topics`, async (t) => {
		const topics = Array.from({ length: 16 }, (_, i) => ({
			title: `세부 업무 ${i + 1}`,
			scope: '고유 업무'
		}));
		const documents = topics.map(({ title }) => ({ ...generated.documents[0], title }));
		interceptAI(t, [
			{ value: { passed: true, reasons: [] } },
			{ value: { topics } },
			{ value: { documents: documents.slice(0, 8) } },
			{
				status: failure === 'incomplete' ? 'incomplete' : 'completed',
				value: {
					documents:
						failure === 'missing'
							? documents.slice(8, 15)
							: failure === 'wrong-batch'
								? documents.slice(0, 8)
								: documents.slice(8)
				}
			}
		]);
		assert.equal((await upload()).status, 500);
		assert.equal(state.database.calls, 0);
		assert.equal(state.database.drafts.length, 0);
	});

test('32 topics run in four bounded batches and wait for the last result before any database write', async (t) => {
	const topics = Array.from({ length: 32 }, (_, i) => ({
		title: `독립 점검 ${i + 1}`,
		scope: '세부 점검 방법'
	}));
	const pending = [];
	let ready;
	const started = new Promise((resolve) => (ready = resolve));
	const calls = interceptAI(t, async (request) => {
		if (request.text?.format?.name === 'wiki_document_topics') return { value: { topics } };
		if (request.text?.format?.name !== 'wiki_documents')
			return { value: { passed: true, reasons: [] } };
		return new Promise((resolve) => {
			pending.push(() =>
				resolve({
					value: {
						documents: JSON.parse(request.input).topics.map(({ title }) => ({
							...generated.documents[0],
							title
						}))
					}
				})
			);
			if (pending.length === 4) ready();
		});
	});
	const uploadResult = upload();
	t.after(() => pending.forEach((release) => release()));
	await Promise.race([
		started,
		uploadResult.then((response) => {
			throw new Error(`Upload ended before batches started: ${response.status}`);
		})
	]);
	assert.equal(calls.length, 6);
	assert.equal(state.database.calls, 0);
	pending[3]();
	pending[2]();
	pending[1]();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(state.database.calls, 0);
	pending[0]();
	assert.equal((await uploadResult).status, 201);
	assert.deepEqual(
		state.database.drafts.map((draft) => draft.title),
		topics.map((topic) => topic.title)
	);
});

test('a failed generation batch aborts its pending sibling without partial database writes', async (t) => {
	const topics = Array.from({ length: 16 }, (_, i) => ({
		title: `중단 점검 ${i + 1}`,
		scope: '세부 점검 방법'
	}));
	let release;
	const siblingStarted = new Promise((resolve) => (release = resolve));
	let aborted = false;
	interceptAI(t, async (request, options) => {
		if (request.text?.format?.name === 'wiki_document_topics') return { value: { topics } };
		if (request.text?.format?.name !== 'wiki_documents')
			return { value: { passed: true, reasons: [] } };
		if (JSON.parse(request.input).topics[0].title === topics[0].title) {
			await siblingStarted;
			return { value: { documents: [] }, status: 'incomplete' };
		}
		return new Promise((resolve, reject) => {
			options.signal.addEventListener(
				'abort',
				() => {
					aborted = true;
					reject(options.signal.reason);
				},
				{ once: true }
			);
			release();
		});
	});
	assert.equal((await upload()).status, 500);
	assert.equal(aborted, true);
	assert.equal(state.database.calls, 0);
});
