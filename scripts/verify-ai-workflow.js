// Bounded real OpenAI + HTTP + PostgreSQL test. Only synthetic fixture content
// is sent to the model; all database writes use a checked disposable schema.
import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { applyMigrations } from './migration-runner.js';
import { hashPassword } from '../src/lib/server/passwords.js';
import { workflowFixtures } from './ai-workflow-fixtures.js';

if (!process.env.OPENAI_API_KEY || !process.env.DATABASE_URL)
	throw Error('Real AI workflow requires configured server credentials.');
const schema = `wiki_test_real_ai_${Date.now()}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const base = 'http://127.0.0.1:5186';
const reviewPath = '/private/tmp/wiki-viki-ai-workflow-review.json';
const query = (fn) =>
	admin.begin(async (tx) => {
		await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
		assert.equal((await tx`SELECT current_schema() AS name`)[0].name, schema);
		await tx`SELECT set_config('wv.operator','1',true)`;
		return fn(tx);
	});
let server;
let cookie = '';
const report = {
	measuredAt: new Date().toISOString(),
	environment: 'Local HTTP + remote Neon disposable schema + real OpenAI',
	modelRequested: process.env.OPENAI_MODEL || 'gpt-5-mini',
	uploads: [],
	answer: null,
	merge: null
};
async function post(path, values, json = false) {
	const response = await fetch(base + path, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			origin: base,
			cookie,
			accept: 'text/html',
			...(json ? { 'content-type': 'application/json' } : {})
		},
		body: json
			? JSON.stringify(values)
			: values instanceof FormData
				? values
				: new URLSearchParams(values),
		signal: AbortSignal.timeout(300000)
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length) cookie = cookies.map((c) => c.split(';')[0]).join('; ');
	return response;
}
const get = (path) =>
	fetch(base + path, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
async function review(stage, data) {
	await writeFile(reviewPath, JSON.stringify({ stage, ...data }, null, 2) + '\n');
	console.log(
		`REVIEW REQUIRED: ${stage}; inspect synthetic sources and output at ${reviewPath}, then enter reviewed to proceed.`
	);
	const value = await new Promise((resolve) => {
		process.stdin.resume();
		process.stdin.once('data', (value) => {
			process.stdin.pause();
			resolve(value.toString().trim());
		});
	});
	assert.equal(value, 'reviewed', 'Review was not confirmed; nothing further is published.');
}
try {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await query(applyMigrations);
	const password = randomBytes(24).toString('hex');
	const hash = await hashPassword(password);
	await query(
		(tx) =>
			tx`INSERT INTO wv_users(handle,role,password_hash) VALUES('Operator-91','admin',${hash})`
	);
	server = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', '5186', '--strictPort'], {
		env: {
			...process.env,
			WIKI_TEST_SCHEMA: schema,
			WIKI_DEMO_MODE: '0',
			WIKI_CONTENT_POLICY: 'strict'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', () => {});
	server.stderr.on('data', (chunk) => {
		for (const line of chunk.toString().split('\n'))
			if (/^(TypeError:|ReferenceError:|Wikifier failed:|session_check_failed)/.test(line.trim()))
				console.log('Fixture server:', line.trim());
	});
	for (let n = 0; n < 80; n++) {
		try {
			if ((await fetch(base + '/login')).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	assert.equal((await post('/login', { handle: 'Operator-91', password })).status, 303);
	const fixtures = await workflowFixtures();
	const reviewedBatches = [];
	for (const file of fixtures) {
		const started = Date.now();
		const form = new FormData();
		form.set('file', file);
		const response = await post('/api/wikify', form);
		assert.equal(response.status, 200);
		const events = [];
		const reader = response.body.getReader(),
			decoder = new TextDecoder();
		let pending = '';
		while (true) {
			const { value, done } = await reader.read();
			pending += decoder.decode(value, { stream: !done });
			const lines = pending.split('\n');
			pending = lines.pop() || '';
			for (const line of lines.filter(Boolean)) {
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === 'progress') console.log(`AI stage ${file.name}: ${event.stage}`);
			}
			if (done) break;
		}
		const done = events.find((e) => e.type === 'done');
		assert.ok(done, JSON.stringify(events));
		assert.equal(done.mode, 'ai');
		assert.equal(
			(await query((tx) => tx`SELECT count(*)::int AS n FROM wv_ai_requests`))[0].n,
			0,
			'Upload releases its request lease'
		);
		assert.ok(
			done.drafts.length >= 2 && done.drafts.length <= 8,
			'Each fixture contains independent concepts and must produce separate drafts'
		);
		const drafts = await query(
			(tx) =>
				tx`SELECT *,updated_at::text AS version FROM drafts WHERE id=ANY(${done.drafts.map((d) => d.id)}) ORDER BY id`
		);
		assert.ok(
			drafts.every(
				(d) =>
					d.status === 'review' &&
					d.governance.aiGenerated === true &&
					d.governance.semantic.skipped === false &&
					d.governance.semantic.passed === true
			)
		);
		const sources = await query(
			(tx) =>
				tx`SELECT kind,label,position,text FROM wv_upload_sources WHERE job_id=${done.jobId} ORDER BY ordinal`
		);
		assert.ok(sources.length > 0);
		assert.ok(sources.every((s) => s.text.trim()));
		assert.equal(
			(await query((tx) => tx`SELECT count(*)::int AS n FROM documents`))[0].n,
			0,
			'Generation must not publish'
		);
		reviewedBatches.push({
			file: file.name,
			jobId: done.jobId,
			sources,
			drafts: drafts.map((d) => ({
				id: d.id,
				title: d.title,
				description: d.description,
				content: d.content,
				aliases: d.aliases,
				version: d.version
			}))
		});
		report.uploads.push({
			format: file.name.split('.').at(-1),
			bytes: file.size,
			elapsedMs: Date.now() - started,
			drafts: drafts.length,
			segments: sources.length,
			segmentKinds: [...new Set(sources.map((s) => s.kind))],
			aiGenerated: true,
			semanticSkipped: false
		});
		console.log(
			`PASS real AI upload: ${file.name}, ${drafts.length} drafts, ${sources.length} source segments, ${Date.now() - started}ms`
		);
	}
	await review('Four-format draft/source comparison before publication', {
		batches: reviewedBatches,
		publicationEdits:
			'각 형식의 첫 초안에 합성 검증 표시와 파일 형식 제목 접두사를 붙이고, 형식 간 겹치는 별칭을 비운 뒤 일반 분야·합성검증 태그로 저장합니다.'
	});
	for (const batch of reviewedBatches) {
		let draft = batch.drafts[0];
		const format = batch.file.split('.').at(-1).toUpperCase();
		const edit = {
			id: draft.id,
			version: draft.version,
			title: `${format} 검증 문서 · ${draft.title}`,
			content: `> 합성 검증 자료입니다. 실제 업무 기준이 아닙니다.\n\n${draft.content}`,
			aliases: '',
			description: draft.description,
			field: '일반',
			tags: '합성검증'
		};
		assert.equal(
			(await post('/drafts?/update', edit)).status,
			303,
			'Reviewed metadata and disclaimer edit'
		);
		[draft] = await query(
			(tx) => tx`SELECT *,updated_at::text AS version FROM drafts WHERE id=${draft.id}`
		);
		assert.equal(draft.content, edit.content);
		assert.deepEqual(draft.aliases, []);
		assert.equal(
			(await post('/drafts?/publish', { id: draft.id, version: draft.version })).status,
			400,
			'No publication without review'
		);
		const result = await post('/drafts?/publish', {
			id: draft.id,
			version: draft.version,
			reviewed: 'yes'
		});
		assert.equal(result.status, 303, await result.clone().text());
		const location = result.headers.get('location');
		const page = await get(location);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /출처/);
		const [published] = await query(
			(tx) =>
				tx`SELECT d.id,(SELECT count(*) FROM wv_document_sources s WHERE s.document_id=d.id)::int AS sources FROM documents d WHERE title=${draft.title}`
		);
		assert.ok(published.sources > 0);
		assert.equal(
			(await post('/drafts?/publish', { id: draft.id, version: draft.version, reviewed: 'yes' }))
				.status,
			404
		);
	}
	console.log(
		'PASS real AI publication: explicit source review, one draft from each format, provenance and repeat rejection'
	);
	const seed = async (title, slug, content) =>
		(
			await query(
				(tx) =>
					tx`SELECT wv_save_document_v1(${tx.json({ title, titleSlug: slug, slug, content, editor: 'Operator-91', field: '일반', description: '합성 검증 자료', sourceName: '합성 검증 원문', aliases: [], tags: [] })}::jsonb) AS document`
			)
		)[0].document;
	const question = '검증기구 점검 주기와 기록 보관 위치';
	const inspection = await seed(
		'검증기구 점검 주기와 기록 보관 위치 · 점검',
		'ai-inspection',
		'## 점검 주기\n\n합성 검증기구의 점검 주기는 3일입니다. 기록 보관 위치는 별도 안내를 따릅니다. 실제 업무 기준이 아닌 테스트 자료입니다.'
	);
	const storage = await seed(
		'검증기구 점검 주기와 기록 보관 위치 · 보관',
		'ai-storage',
		'## 기록 보관\n\n합성 검증기구의 점검 기록 보관 위치는 파란 보관함입니다. 점검 주기는 별도 안내를 따릅니다. 실제 업무 기준이 아닌 테스트 자료입니다.'
	);
	const answerStart = Date.now();
	const response = await post('/api/answer', { q: question }, true);
	assert.equal(response.status, 200);
	const answer = await response.json();
	assert.equal(answer.state, 'ready', JSON.stringify(answer));
	assert.deepEqual(
		new Set(answer.sources.map((s) => s.documentId)),
		new Set([String(inspection.id), String(storage.id)])
	);
	const answerText = answer.paragraphs.map((p) => p.text).join(' ');
	assert.match(answerText, /3일/);
	assert.match(answerText, /파란/);
	for (const source of answer.sources) {
		const page = await get(source.url);
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.ok(html.includes(`id="${source.anchor}"`));
		assert.equal(
			(
				await query(
					(tx) =>
						tx`SELECT count(*)::int AS n FROM revisions WHERE id=${source.revisionId} AND document_id=${source.documentId}`
				)
			)[0].n,
			1
		);
	}
	report.answer = {
		elapsedMs: Date.now() - answerStart,
		documents: 2,
		citations: answer.sources.length,
		allRevisionAnchorsResolved: true
	};
	assert.equal(
		(await query((tx) => tx`SELECT count(*)::int AS n FROM wv_ai_requests`))[0].n,
		0,
		'Answer releases its request lease'
	);
	console.log(
		'PASS real AI answer: two actual published documents, exact revision and paragraph links'
	);
	const target = await seed(
		'가상 시험 기구 관리',
		'ai-merge-target',
		'## 점검\n\n점검 주기는 7일입니다.\n\n## 보관\n\n사용하지 않을 때는 파란 보관함에 보관합니다.'
	);
	const [draft] = await query(
		(tx) =>
			tx`INSERT INTO drafts(title,slug,content,source_name) VALUES('가상 시험 기구 관리','ai-merge-incoming','## 점검\n\n점검 주기는 3일로 변경합니다.','합성 변경 자료') RETURNING *,updated_at::text AS version`
	);
	const mergeStart = Date.now();
	const prepared = await post('/drafts?/prepareMerge', {
		id: draft.id,
		version: draft.version,
		targetId: target.id
	});
	assert.equal(prepared.status, 303, await prepared.clone().text());
	assert.equal(
		(await query((tx) => tx`SELECT count(*)::int AS n FROM wv_ai_requests`))[0].n,
		0,
		'Merge releases its request lease'
	);
	const [planned] = await query(
		(tx) => tx`SELECT *,updated_at::text AS version FROM drafts WHERE id=${draft.id}`
	);
	const plan = planned.governance.merge;
	assert.match(plan.content, /3일/);
	assert.match(plan.content, /파란 보관함/);
	assert.ok(plan.conflicts.some((c) => c.previous.includes('7일') && c.incoming.includes('3일')));
	assert.match(
		(await query((tx) => tx`SELECT content FROM documents WHERE id=${target.id}`))[0].content,
		/7일/
	);
	await review('Real AI merge before applying', {
		previous: target.content,
		incoming: draft.content,
		plan,
		finalContent: plan.content + '\n\n> 합성 검증용 통합안입니다.'
	});
	const apply = {
		id: draft.id,
		version: planned.version,
		mergeId: plan.id,
		content: plan.content + '\n\n> 합성 검증용 통합안입니다.',
		reviewed: 'yes'
	};
	assert.equal((await post('/drafts?/applyMerge', { ...apply, reviewed: '' })).status, 400);
	assert.equal((await post('/drafts?/applyMerge', apply)).status, 303);
	assert.equal((await post('/drafts?/applyMerge', apply)).status, 409);
	const [revision] = await query(
		(tx) => tx`SELECT * FROM revisions WHERE document_id=${target.id} ORDER BY id DESC LIMIT 1`
	);
	assert.match(revision.content, /3일/);
	assert.equal(revision.details.type, 'ai_merge');
	assert.equal(revision.details.manuallyEdited, true);
	assert.ok(
		revision.details.conflicts.some((c) => c.previous.includes('7일') && c.incoming.includes('3일'))
	);
	report.merge = {
		elapsedMs: Date.now() - mergeStart,
		conflicts: plan.conflicts.length,
		oldContentPreserved: true,
		appliedOnce: true
	};
	report.status = 'passed';
	await writeFile(
		new URL('../docs/ai-workflow-verification.json', import.meta.url),
		JSON.stringify(report, null, 2) + '\n'
	);
	console.log(
		'PASS real AI end to end: four formats, reviewed publication, grounded answer, reviewed conflict merge and history'
	);
} catch (cause) {
	console.error('Real AI workflow failed:', cause.name, cause.message, cause.cause?.code || '');
	try {
		console.log(
			'Synthetic job states:',
			await query((tx) => tx`SELECT state,stage,message FROM wv_upload_jobs ORDER BY id`)
		);
	} catch {}
	process.exitCode = 1;
} finally {
	if (server) {
		server.kill('SIGTERM');
		await new Promise((resolve) => {
			server.once('exit', resolve);
			setTimeout(resolve, 2000);
		});
	}
	await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
	await admin.end();
}
