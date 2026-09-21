// Run against a running local app. Only this run's uniquely named fixtures are removed.
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { neon } from '@neondatabase/serverless';
try {
	process.loadEnvFile?.();
} catch {
	/* Environment can also be supplied by the caller. */
}
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
	throw new Error('Use a local test server.');
const stamp = `prototype-check-${Date.now()}`;
const docs = new Set();
const drafts = new Set();
async function post(path, values) {
	return fetch(base + path, {
		method: 'POST',
		headers: { origin: base, accept: 'text/html' },
		body: values instanceof FormData ? values : new URLSearchParams(values),
		redirect: 'manual'
	});
}
async function page(path) {
	const response = await fetch(base + path);
	assert.equal(response.status, 200, path);
	return response.text();
}
try {
	for (const suffix of ['one', 'two']) {
		const slug = `${stamp}-${suffix}`;
		docs.add(slug);
		const response = await post(`/edit/${slug}?/save`, {
			title: slug,
			content: `## 개요\n\n검증용 문서입니다. ${suffix === 'two' ? `[[${stamp}-one]]` : ''}`,
			editor: 'Operator-07',
			summary: '자동 검증용 생성',
			aliases: suffix === 'one' ? `${stamp}-alias` : '',
			field: '절차',
			description: '검증용 설명입니다.',
			sourceName: '자동 검증'
		});
		assert.equal(
			response.status,
			303,
			(await response.text()).replace(/<style[\s\S]*?<\/style>/g, '').slice(-4500)
		);
	}
	console.log('PASS document creation and redirects');
	let results = await (await fetch(`${base}/api/search?q=${stamp}-alias`)).json();
	assert.equal(results[0].slug, `${stamp}-one`);
	assert.match(await page(`/wiki/${stamp}-alias`), /에서 넘어왔습니다/);
	assert.match(await page(`/?q=${stamp}&field=절차`), /바로 읽히는 설명/);
	assert.match(await page(`/wiki/${stamp}-one`), /역링크 1/);
	console.log('PASS alias search, answer card, field filter and backlinks');
	const edit = await post(`/edit/${stamp}-one?/save`, {
		title: `${stamp}-one`,
		content: '## 개요\n\n수정된 검증 내용입니다.',
		editor: 'Editor-01',
		summary: '검증용 내용 수정',
		aliases: `${stamp}-alias`,
		field: '절차',
		description: '수정 설명',
		sourceName: '자동 검증'
	});
	assert.equal(edit.status, 303, (await edit.text()).slice(-4500));
	const history = await page(`/history/${stamp}-one`);
	assert.match(history, /검증용 내용 수정/);
	const ids = [...history.matchAll(/name="revision" value="(\d+)"/g)].map((match) => match[1]);
	assert.equal(ids.length, 2);
	assert.match(await page(`/history/${stamp}-one?diff=${ids[0]}`), /diff-add/);
	const discussion = await post(`/discussion/${stamp}-one`, {
		title: '검증용 토론',
		body: '문서 연결이 정상인지 확인합니다.',
		editor: 'Operator-07'
	});
	assert.equal(discussion.status, 200);
	assert.match(await discussion.text(), /토론을 등록했습니다/);
	const rollback = await post(`/history/${stamp}-one?/rollback`, { revision: ids[1] });
	assert.equal(rollback.status, 303);
	assert.match(await page(`/wiki/${stamp}-one`), /검증용 문서입니다/);
	console.log('PASS editing, revision diff, discussion and rollback');
	const invalid = new FormData();
	invalid.set('file', new File(['bad'], 'bad.txt'));
	invalid.set('editor', 'Operator-07');
	assert.equal((await post('/api/wikify', invalid)).status, 415);
	const demo = new FormData();
	demo.set('demo', 'true');
	demo.set('editor', 'Operator-07');
	const demoResponse = await post('/api/wikify', demo);
	assert.equal(demoResponse.status, 200);
	const events = (await demoResponse.text()).trim().split('\n').map(JSON.parse);
	const result = events.find((event) => event.type === 'done');
	assert.ok(result, JSON.stringify(events));
	for (const draft of result.drafts) drafts.add(draft.id);
	assert.equal(result.drafts.length, 7);
	assert.ok(result.links > 0);
	const first = result.drafts[0];
	assert.match(await page(`/drafts?open=${first.id}`), /프로토타입/);
	const title = `${stamp}-published`;
	docs.add(title);
	const update = await post('/drafts?/update', {
		id: first.id,
		title,
		content: '## 개요\n\n공유 문서는 서로 연결하고 변경 내용을 기록합니다.',
		editor: 'Operator-07',
		field: '일반',
		description: '검증용 게시 초안',
		aliases: `${stamp}-published-alias`
	});
	assert.equal(
		update.status,
		303,
		(await update.text()).replace(/<style[\s\S]*?<\/style>/g, '').slice(-4500)
	);
	const publication = await post('/drafts?/publish', {
		id: first.id,
		editor: 'Operator-07',
		reviewed: 'yes'
	});
	assert.equal(
		publication.status,
		303,
		(await publication.text()).replace(/<style[\s\S]*?<\/style>/g, '').slice(-4500)
	);
	assert.match(await page(`/wiki/${title}`), /공유 문서는 서로 연결/);
	const repeat = await post('/drafts?/publish', {
		id: first.id,
		editor: 'Operator-07',
		reviewed: 'yes'
	});
	assert.equal(repeat.status, 404);
	console.log('PASS streamed multi-draft demo, review, publish, duplicate protection');
	if (process.env.TEST_UPLOAD === '1' || process.env.TEST_AI_UPLOAD === '1') {
		const zip = new JSZip();
		zip.file(
			'[Content_Types].xml',
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
		);
		zip.file(
			'_rels/.rels',
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
		);
		zip.file(
			'word/document.xml',
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>공유 문서 검토 안내</w:t></w:r></w:p><w:p><w:r><w:t>문서를 읽고 원문과 일치하는지 확인합니다. 변경한 부분은 편집 요약에 기록합니다.</w:t></w:r></w:p></w:body></w:document>'
		);
		const upload = new FormData();
		upload.set(
			'file',
			new File([await zip.generateAsync({ type: 'uint8array' })], `${stamp}.docx`)
		);
		upload.set('editor', 'Operator-07');
		if (process.env.TEST_AI_UPLOAD !== '1') upload.set('basic', 'true');
		const response = await post('/api/wikify', upload);
		const parsed = (await response.text()).trim().split('\n').map(JSON.parse);
		const generated = parsed.find((event) => event.type === 'done');
		assert.ok(generated, JSON.stringify(parsed));
		for (const draft of generated.drafts) drafts.add(draft.id);
		console.log(`PASS real DOCX conversion (${generated.mode}, ${generated.drafts.length} drafts)`);
	}
	console.log('All integration checks passed.');
} finally {
	for (const id of drafts) await post('/drafts?/delete', { id: String(id) });
	if (drafts.size && process.env.DATABASE_URL)
		await neon(process.env.DATABASE_URL)`DELETE FROM drafts WHERE id=ANY(${[...drafts]})`;
	for (const slug of docs) await post(`/edit/${slug}?/delete`, {});
	console.log(`Removed this run's ${docs.size} documents and unpublished test drafts.`);
}
