// Own disposable schema only. No public writes, no external AI calls.
import postgres from 'postgres';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { checkUploadTransfers } from './upload-transfer-checks.js';
import { draftFingerprint } from '../src/lib/server/merge-contract.js';
import { searchOptions } from '../src/lib/search.js';
import { hashPassword } from '../src/lib/server/passwords.js';
import { randomBytes } from 'node:crypto';
try {
	process.loadEnvFile?.();
} catch {}
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const schema = `wiki_test_http_${Date.now()}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const base = 'http://127.0.0.1:5184';
let server;
let cookie = '';
const query = async (fn) =>
	admin.begin(async (tx) => {
		await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
		assert.equal((await tx`SELECT current_schema() AS name`)[0].name, schema);
		await tx`SELECT set_config('wv.operator','1',true)`;
		return fn(tx);
	});
async function post(path, values) {
	const response = await fetch(base + path, {
		method: 'POST',
		headers: { origin: base, accept: 'text/html', cookie },
		body: values instanceof FormData ? values : new URLSearchParams(values),
		redirect: 'manual'
	});
	const setCookies = response.headers.getSetCookie();
	if (setCookies.length) cookie = setCookies.map((s) => s.split(';')[0]).join('; ');
	return response;
}
async function page(path) {
	const res = await fetch(base + path, { headers: { cookie } });
	assert.equal(res.status, 200, path);
	return res.text();
}
try {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await query(async (tx) => {
		for (const name of (await readdir(new URL('../migrations/', import.meta.url)))
			.filter((n) => n.endsWith('.sql'))
			.sort())
			await tx.unsafe(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	});
	server = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', '5184', '--strictPort'], {
		env: {
			...process.env,
			OPENAI_API_KEY: '',
			WIKI_TEST_SCHEMA: schema,
			WIKI_DEMO_MODE: '1',
			WIKI_CONTENT_POLICY: 'strict'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// Do not print unfiltered server logs or connection errors that could contain credentials.
	server.stdout.on('data', () => {});
	server.stderr.on('data', () => {});
	for (let i = 0; i < 60; i++) {
		try {
			if ((await fetch(base)).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (process.env.WIKI_TRANSFERS_ONLY === '1' || process.argv.includes('--transfers-only')) {
		await checkUploadTransfers({ base, query });
	} else {
		const values = {
			title: 'fixture',
			content: '## 개요\n\n검증용 안전한 본문',
			editor: 'Editor-01',
			aliases: 'fixture-alias',
			field: '일반',
			description: '검증용 설명',
			sourceName: '검증용 원문',
			summary: '검증용 생성'
		};
		assert.equal((await post('/edit/fixture?/save', values)).status, 303);
		let document = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='fixture'`
			)
		)[0];
		assert.match(await page('/wiki/fixture-alias'), /에서 넘어왔습니다/);
		const update = {
			...values,
			id: document.id,
			version: document.version,
			content: '## 개요\n\n첫 수정 본문',
			aliases: ''
		};
		assert.equal((await post('/edit/fixture?/save', update)).status, 303);
		assert.equal(
			(await post('/edit/fixture?/save', { ...update, content: '오래된 입력' })).status,
			409
		);
		assert.equal((await query((tx) => tx`SELECT count(*)::int AS n FROM redirects`))[0].n, 0);
		document = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='fixture'`
			)
		)[0];
		const failures = await post('/edit/fixture?/save', {
			...update,
			version: document.version,
			aliases: 'person@example.com'
		});
		assert.equal(failures.status, 400);
		assert.match(await failures.text(), /person@example.com/);
		assert.equal(
			(
				await post('/discussion/fixture', {
					title: '검증 토론',
					body: '검증 의견',
					editor: 'Editor-01'
				})
			).status,
			200
		);
		const revision = (await query((tx) => tx`SELECT id FROM revisions ORDER BY id LIMIT 1`))[0];
		assert.equal(
			(
				await post('/history/fixture?/rollback', {
					revision: revision.id,
					version: document.version,
					editor: 'Editor-01'
				})
			).status,
			303
		);
		document = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='fixture'`
			)
		)[0];
		assert.equal(
			(await post('/edit/fixture?/delete', { version: document.version, editor: 'Editor-01' }))
				.status,
			303
		);
		assert.deepEqual(await (await fetch(base + '/api/search?q=fixture')).json(), []);
		assert.match(await page('/wiki/fixture'), /아직 작성되지 않은 문서/);
		document = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='fixture'`
			)
		)[0];
		assert.equal(
			(
				await post('/trash?/restore', {
					id: document.id,
					version: document.version,
					editor: 'Editor-01'
				})
			).status,
			303
		);
		assert.match(await page('/discussion/fixture'), /검증 의견/);
		console.log(
			'PASS HTTP: create, aliases, stale edit, failed input preservation, rollback, trash visibility and relationship restore'
		);
		const zip = new JSZip();
		zip.file(
			'[Content_Types].xml',
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
		);
		zip.file(
			'_rels/.rels',
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
		);
		zip.file(
			'word/document.xml',
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>입력 검증 안내</w:t></w:r></w:p><w:p><w:r><w:t>초안을 검토하고 명시적으로 게시합니다.</w:t></w:r></w:p></w:body></w:document>'
		);
		const form = new FormData();
		form.set('file', new File([await zip.generateAsync({ type: 'uint8array' })], 'fixture.docx'));
		form.set('editor', 'Editor-01');
		const events = (await (await post('/api/wikify', form)).text())
			.trim()
			.split('\n')
			.map(JSON.parse);
		const done = events.find((e) => e.type === 'done');
		assert.ok(done, JSON.stringify(events));
		assert.ok(done.jobId);
		const repeated = (await (await post('/api/wikify', form)).text())
			.trim()
			.split('\n')
			.map(JSON.parse)
			.find((e) => e.type === 'done');
		assert.equal(repeated.jobId, done.jobId);
		assert.equal(repeated.reused, true);
		assert.deepEqual(repeated.drafts, done.drafts);
		assert.equal((await query((tx) => tx`SELECT count(*)::int AS n FROM wv_upload_jobs`))[0].n, 1);
		assert.equal((await query((tx) => tx`SELECT count(*)::int AS n FROM drafts`))[0].n, 1);
		assert.ok((await query((tx) => tx`SELECT count(*)::int AS n FROM wv_draft_sources`))[0].n > 0);
		const ownJobs = await (
			await fetch(base + `/api/uploads?job=${done.jobId}`, { headers: { cookie } })
		).json();
		assert.equal(ownJobs[0].state, 'completed');
		assert.deepEqual(await (await fetch(base + `/api/uploads?job=${done.jobId}`)).json(), []);
		assert.match(await page(`/uploads?open=${done.jobId}`), /초안 저장 완료/);
		assert.match(await page(`/drafts?open=${done.drafts[0].id}`), /원문 대조/);
		console.log(
			'PASS upload recovery: same file returns one job and batch, source segments persist, own-cookie status only'
		);

		assert.equal(done.mode, 'basic');
		assert.equal(done.drafts.length, 1);
		let draft = (
			await query((tx) => tx`SELECT id,updated_at::text AS version,governance FROM drafts`)
		)[0];
		assert.equal(draft.governance.semantic.skipped, true);
		assert.equal(
			(
				await post('/drafts?/update', {
					id: draft.id,
					version: draft.version,
					title: 'draft-fixture',
					content: '## 개요\n\n검토한 게시 본문',
					editor: 'Editor-01',
					field: '일반',
					aliases: 'draft-alias',
					tags: '검증, 원문대조'
				})
			).status,
			303
		);
		assert.equal(
			(await post('/drafts?/delete', { id: draft.id, version: draft.version })).status,
			409
		);
		draft = (await query((tx) => tx`SELECT id,updated_at::text AS version FROM drafts`))[0];
		const noKey = await post('/drafts?/prepareMerge', {
			id: draft.id,
			version: draft.version,
			targetId: document.id
		});
		assert.equal(noKey.status, 400);
		assert.match(await noKey.text(), /AI 통합에는 API 키가 필요/);
		assert.equal(
			(
				await post('/drafts?/publish', {
					id: draft.id,
					version: draft.version,
					editor: 'Editor-01',
					reviewed: 'yes'
				})
			).status,
			303
		);
		assert.equal(
			(
				await post('/drafts?/publish', {
					id: draft.id,
					version: draft.version,
					editor: 'Editor-01',
					reviewed: 'yes'
				})
			).status,
			404
		);
		assert.match(await page('/wiki/draft-alias'), /검토한 게시 본문/);
		assert.match(await page('/wiki/draft-alias'), /추출 문단/);
		const sourceLinks = await query(
			(tx) =>
				tx`SELECT ds.document_id,ds.source_id FROM wv_document_sources ds JOIN documents d ON d.id=ds.document_id WHERE d.slug='draft-fixture'`
		);
		const [sourceRevision] = await query(
			(tx) =>
				tx`SELECT r.id FROM revisions r JOIN documents d ON d.id=r.document_id WHERE d.slug='draft-fixture' ORDER BY r.id DESC LIMIT 1`
		);
		await query(
			(tx) => tx`DELETE FROM wv_document_sources WHERE document_id=${sourceLinks[0].document_id}`
		);
		assert.match(
			await page(`/wiki/draft-fixture?revision=${sourceRevision.id}`),
			/추출 문단/,
			'historical source remains available after current associations change'
		);
		await query(async (tx) => {
			for (const link of sourceLinks)
				await tx`INSERT INTO wv_document_sources(document_id,source_id) VALUES(${link.document_id},${link.source_id})`;
		});
		assert.deepEqual(
			(
				await query(
					(tx) =>
						tx`SELECT tag FROM wv_document_tags t JOIN documents d ON d.id=t.document_id WHERE d.slug='draft-fixture' ORDER BY tag`
				)
			).map((r) => r.tag),
			['검증', '원문대조']
		);
		console.log(
			'PASS HTTP: DOCX no-key draft, inspection skipped, draft version checks and one-time reviewed publication'
		);
		const target = (
			await query(
				(tx) => tx`SELECT *,updated_at::text AS version FROM documents WHERE id=${document.id}`
			)
		)[0];
		const incoming = (
			await query(
				(tx) =>
					tx`INSERT INTO drafts (title,slug,content,source_name) VALUES ('merge-fixture','merge-fixture','점검은 3일마다 진행합니다.','합성 자료') RETURNING *`
			)
		)[0];
		const plan = {
			id: 'http-plan',
			targetId: target.id,
			targetTitle: target.title,
			targetSlug: target.slug,
			targetVersion: target.version,
			previousContent: target.content,
			content: '점검은 3일마다 진행합니다. 파란 보관함에 보관합니다.',
			summary: '검증용 통합',
			conflicts: [{ topic: '점검 주기', previous: '7일', incoming: '3일' }],
			draftFingerprint: draftFingerprint(incoming)
		};
		const [prepared] = await query(
			(tx) =>
				tx`UPDATE drafts SET governance=${tx.json({ merge: plan })},updated_at=clock_timestamp() WHERE id=${incoming.id} RETURNING updated_at::text AS version`
		);
		assert.match(await page(`/drafts?open=${incoming.id}`), /새 초안 우선/);
		const mergeValues = {
			id: incoming.id,
			version: prepared.version,
			mergeId: plan.id,
			content: plan.content + ' 검토자가 확인했습니다.',
			editor: 'Editor-01'
		};
		assert.equal((await post('/drafts?/applyMerge', mergeValues)).status, 400);
		assert.equal(
			(await post('/drafts?/applyMerge', { ...mergeValues, reviewed: 'yes' })).status,
			303
		);
		assert.equal(
			(await post('/drafts?/applyMerge', { ...mergeValues, reviewed: 'yes' })).status,
			409
		);
		const history = await page('/history/fixture');
		assert.match(history, /상충 상세/);
		assert.match(history, /검토자가 AI 통합 본문을 추가 수정/);
		console.log(
			'PASS HTTP mocked merge: manual review required, apply once, custom content and conflict history; no-key generation is unavailable'
		);
		const samples = [
			[
				'RFCC',
				'rfcc',
				['잔사유 유동층 접촉분해', 'Residue Fluid Catalytic Cracking'],
				'공정',
				'## 개요\n\n[예시 문서] RFCC는 촉매 순환을 설명하기 위한 합성 자료입니다. [[CDU]]와 [[산단스팀]]을 연결합니다.\n\n## 점검\n\n검토한 운전 기준이 아닙니다. 문서 연결과 검색을 검증하는 내용입니다.'
			],
			[
				'상압증류탑',
				'상압증류탑',
				['CDU', 'Crude Distillation Unit'],
				'설비',
				'## 개요\n\n상압증류탑의 합성 설명입니다. 실제 운전 기준이 아닌 예시입니다. [[RFCC]]와 [[미작성 검증 용어]]를 연결합니다.'
			],
			[
				'산단스팀',
				'산단스팀',
				['산업단지 공급 스팀'],
				'유틸리티',
				'## 개요\n\n산단스팀 공급과 RFCC 사이의 연결을 설명하는 합성 예시 문서입니다. [[RFCC]]'
			],
			[
				'정비 요청 프로세스',
				'정비-요청-프로세스',
				['정비요청'],
				'절차',
				'## 개요\n\n정비 요청의 등록과 검토를 안내하는 예시입니다. 실제 승인된 절차가 아닙니다.'
			],
			[
				'교대 인수인계 체크리스트',
				'교대-인수인계-체크리스트',
				['인수인계'],
				'절차',
				'## 개요\n\n교대 인수인계 시 전달할 항목을 설명하기 위한 합성 예시 자료입니다.'
			]
		];
		await query(async (tx) => {
			for (const [title, slug, names, field, content] of samples) {
				await tx`SELECT wv_save_document_v1(${tx.json({ title, slug, titleSlug: slug, content, editor: 'Editor-01', summary: '격리 검색 검증', field, description: '합성 예시 자료', sourceName: '검증 fixture', aliases: names.map((title) => ({ title, slug: title.toLowerCase().replaceAll(' ', '-') })), tags: ['검증', '예시'] })}::jsonb)`;
			}
			for (let i = 1; i <= 22; i++)
				await tx`SELECT wv_save_document_v1(${tx.json({ title: '페이지 검증 ' + i, slug: 'page-' + i, content: '페이지 이동을 확인하는 안전한 합성 문서 본문입니다.', editor: 'Editor-01', field: '일반', description: '페이지 fixture', sourceName: '', aliases: [], tags: [] })}::jsonb)`;
		});
		const cases = [
			['RFCC', 'rfcc'],
			['RFCC는 무엇인가요?', 'rfcc'],
			['잔사유 유동층 접촉분해', 'rfcc'],
			['CDU', '상압증류탑'],
			['Crude Distillation Unit', '상압증류탑'],
			['산업단지 공급 스팀', '산단스팀'],
			['산단 스팀', '산단스팀'],
			['정비요청', '정비-요청-프로세스'],
			['정비 요청 프로세스', '정비-요청-프로세스'],
			['인수인계', '교대-인수인계-체크리스트']
		];
		for (const [q, expected] of cases) {
			const res = await fetch(base + '/api/search?q=' + encodeURIComponent(q));
			assert.equal(res.status, 200);
			assert.equal((await res.json())[0]?.slug, expected, q);
		}
		const filtered = await query(
			(tx) =>
				tx`SELECT wv_search_documents_v1(${tx.json(searchOptions(new URLSearchParams('browse=1&field=설비&tag=검증')))}::jsonb) AS result`
		);
		assert.equal(filtered[0].result.total, 1);
		assert.equal(filtered[0].result.results[0].slug, '상압증류탑');
		const paged = await query(
			(tx) =>
				tx`SELECT wv_search_documents_v1(${tx.json(searchOptions(new URLSearchParams('q=페이지&page=2&limit=20')))}::jsonb) AS result`
		);
		assert.equal(paged[0].result.total, 22);
		assert.equal(paged[0].result.results.length, 2);
		assert.ok(!('content' in paged[0].result.results[0]));
		assert.match(await page('/?q=RFCC'), /문서로 AI 설명 만들기/);
		assert.match(await page('/?browse=1&field=설비&tag=검증'), /상압증류탑/);
		assert.match(await page('/?q=페이지&page=2'), /2 \/ 2 페이지/);
		assert.match(await page('/?view=map&center=rfcc'), /중심 연결/);
		assert.match(await page('/quality?kind=missing'), /미작성 검증 용어/);
		assert.match(await page('/history/fixture?restore=' + revision.id), /되돌리기 전 비교/);
		assert.match(await page('/wiki/fixture?revision=' + revision.id), /검증용 안전한 본문/);
		const noAI = await fetch(base + '/api/answer', {
			method: 'POST',
			headers: { origin: base, 'content-type': 'application/json' },
			body: JSON.stringify({ q: 'RFCC' })
		});
		assert.equal(noAI.status, 503);
		assert.equal((await noAI.json()).state, 'unavailable');
		const unsafe = await fetch(base + '/api/answer', {
			method: 'POST',
			headers: { origin: base, 'content-type': 'application/json' },
			body: JSON.stringify({ q: 'person@example.com' })
		});
		assert.equal(unsafe.status, 400);
		assert.equal((await unsafe.json()).state, 'blocked');
		console.log(
			'PASS search: 10 domain/alias/Korean queries, field+tag filters, page 2, bounded excerpts, map, quality, revision snapshots and no-key/blocked AI states'
		);
		const batch = await query(
			(tx) =>
				tx`INSERT INTO drafts(title,slug,content) VALUES('batch-a','batch-a','검토할 본문'),('batch-b','batch-b','두 번째 본문') RETURNING id,updated_at::text AS version`
		);
		function selectionForm(items) {
			const form = new FormData();
			form.set('editor', 'Editor-01');
			form.set('confirmed', 'yes');
			for (const d of items) form.append('selected', `${d.id}|${d.version}`);
			return form;
		}
		assert.equal((await post('/drafts?/publishSelected', selectionForm(batch))).status, 409);
		for (const d of batch)
			assert.equal(
				(
					await post('/drafts?/markReviewed', {
						id: d.id,
						version: d.version,
						editor: 'Editor-01',
						reviewed: 'yes'
					})
				).status,
				303
			);
		await query((tx) => tx`UPDATE drafts SET updated_at=clock_timestamp() WHERE id=${batch[1].id}`);
		assert.equal((await post('/drafts?/publishSelected', selectionForm(batch))).status, 409);
		assert.equal(
			(
				await query(
					(tx) => tx`SELECT count(*)::int AS n FROM documents WHERE slug IN('batch-a','batch-b')`
				)
			)[0].n,
			0
		);
		batch[1] = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM drafts WHERE id=${batch[1].id}`
			)
		)[0];
		assert.equal(
			(await post('/drafts?/markReviewed', { ...batch[1], editor: 'Editor-01', reviewed: 'yes' }))
				.status,
			303
		);
		assert.equal((await post('/drafts?/publishSelected', selectionForm(batch))).status, 303);
		assert.equal((await post('/drafts?/publishSelected', selectionForm(batch))).status, 409);
		assert.equal(
			(
				await query(
					(tx) => tx`SELECT count(*)::int AS n FROM documents WHERE slug IN('batch-a','batch-b')`
				)
			)[0].n,
			2
		);
		console.log(
			'PASS selected publication: individual review, stale selection rejects whole batch, one-time publication, published tags and source provenance'
		);

		await checkUploadTransfers({ base, query });
		if (process.env.WIKI_BENCHMARK === '1' || process.argv.includes('--benchmark')) {
			const benchPassword = randomBytes(24).toString('hex');
			const benchHash = await hashPassword(benchPassword);
			const [benchUser] = await query(
				(tx) =>
					tx`INSERT INTO wv_users(handle,role,password_hash) VALUES('Editor-100','reader',${benchHash}) RETURNING id`
			);
			assert.equal(
				(await post('/login', { handle: 'Editor-100', password: benchPassword })).status,
				303
			);
			assert.equal(
				(await fetch(base + '/admin/users', { headers: { cookie }, redirect: 'manual' })).status,
				403,
				'benchmark requests are authenticated as a reader'
			);
			await query(async (tx) => {
				const count = (
					await tx`SELECT count(*)::int AS n FROM documents WHERE deleted_at IS NULL`
				)[0].n;
				await tx`INSERT INTO documents(slug,title,content,field,description,source_name) SELECT 'bench-'||i,'벤치마크 문서 '||i,'## 개요'||chr(10)||chr(10)||'검증용 합성 공정 문서입니다. 실제 운전 기준이 아닙니다. 기록 확인 절차와 안전한 자료 보관을 설명합니다. [[RFCC]] [[산단스팀]] [[벤치마크 문서 '||greatest(1,i-1)||']]'||chr(10)||chr(10)||repeat('추가 합성 설명입니다. ',30),'공정','측정용 합성 자료','벤치마크 fixture' FROM generate_series(1,${1000 - count}) i`;
				await tx`INSERT INTO revisions(document_id,content,editor_handle,summary) SELECT id,content,'Editor-01','격리 성능 검증' FROM documents d WHERE NOT EXISTS(SELECT 1 FROM revisions r WHERE r.document_id=d.id)`;
				await tx`ANALYZE documents`;
				await tx`ANALYZE redirects`;
				await tx`ANALYZE wv_document_links`;
			});
			const corpus = (
				await query(
					(tx) =>
						tx`SELECT count(*)::int AS documents,sum(length(content))::bigint AS characters FROM documents WHERE deleted_at IS NULL`
				)
			)[0];
			const explain = (
				await query(async (tx) => {
					await tx`SELECT set_config('wv.operator','0',true),set_config('wv.actor_id',${String(benchUser.id)},true),set_config('wv.actor_role','reader',true)`;
					return tx.unsafe(
						'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT wv_search_documents_v1(\'{"q":"RFCC","terms":["rfcc"],"normalized":"rfcc","limit":5,"page":1}\'::jsonb)'
					);
				})
			)[0]['QUERY PLAN'];
			const times = [];
			const queries = ['RFCC', 'CDU', '정비 요청', '산단 스팀', '벤치마크 문서 12', '없는검증문서'];
			for (let i = 0; i < 60; i++) {
				const q = queries[i % queries.length];
				const started = performance.now();
				const response = await fetch(base + '/api/search?q=' + encodeURIComponent(q), {
					headers: { cookie }
				});
				assert.equal(response.status, 200);
				await response.json();
				times.push(Math.round((performance.now() - started) * 100) / 100);
			}
			const sorted = [...times].sort((a, b) => a - b);
			const result = {
				measuredAt: new Date().toISOString(),
				environment:
					'Authenticated reader, local Vite dev + remote Neon, isolated schema; not production, Node ' +
					process.version,
				corpus,
				queries,
				samples: times.length,
				firstRequestMs: times[0],
				p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
				p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
				maxMs: sorted.at(-1),
				timesMs: times,
				explain,
				notes: [
					'No external AI calls',
					'Includes a database-backed session lookup and current plus historical access rules',
					'30 Korean/alias fixtures plus synthetic filler up to 1,000 documents',
					'Sequential HTTP API requests, serverless production cold start and user usability unmeasured'
				]
			};
			await writeFile(
				new URL('../docs/search-benchmark-authenticated.json', import.meta.url),
				JSON.stringify(result, null, 2) + '\n'
			);
			console.log(
				'BENCHMARK ' +
					JSON.stringify({
						documents: corpus.documents,
						samples: result.samples,
						p50Ms: result.p50Ms,
						p95Ms: result.p95Ms,
						maxMs: result.maxMs
					})
			);
		}

		if (process.env.WIKI_UI_PREVIEW === '1') {
			console.log(
				'ISOLATED UI PREVIEW ready: http://127.0.0.1:5184/ (press Enter to stop and remove only this test schema)'
			);
			await new Promise((resolve) => process.stdin.once('data', resolve));
			process.stdin.pause();
		}
	}
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
