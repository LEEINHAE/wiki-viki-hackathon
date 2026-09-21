import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { manageFixtureDocument, createFixtureProposal } from './fixture-document-management.js';
export async function verifyHistoricalAccess({ query, reader, editor, operator }) {
	const slug = 'historical-access-fixture';
	const post = (actor, path, values) => actor(path, values);
	const current = async () =>
		(
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug=${slug}`
			)
		)[0];
	assert.equal(
		(
			await post(editor, `/edit/${slug}?/save`, {
				title: slug,
				content: '공개된 합성 안내',
				field: '일반'
			})
		).status,
		303
	);
	let d = await current();
	const [initialRevision] = await query(
		(tx) => tx`SELECT id FROM revisions WHERE document_id=${d.id} ORDER BY id LIMIT 1`
	);
	assert.equal(
		(
			await reader(
				'/api/personal',
				JSON.stringify({ action: 'subscribe', documentId: d.id, value: true })
			)
		).status,
		200
	);
	assert.equal(
		(await post(reader, `/discussion/${slug}`, { title: '공개 토론 주제', body: '공개 질문' }))
			.status,
		200
	);
	const [publicThread] = await query(
		(tx) => tx`SELECT id FROM discussions WHERE document_id=${d.id}`
	);
	await manageFixtureDocument(query, slug, {
		action: 'access',
		version: d.version,
		minRole: 'admin'
	});
	d = await current();
	assert.equal(
		(await reader(`/api/export/${slug}`)).status,
		404,
		'Export checks current document access'
	);
	assert.equal(
		(
			await post(operator, `/edit/${slug}?/save`, {
				id: d.id,
				title: slug,
				version: d.version,
				content: '비공개로 기록한 합성 본문',
				field: '일반'
			})
		).status,
		303
	);
	const [privateRevision] = await query(
		(tx) => tx`SELECT id FROM revisions WHERE document_id=${d.id} ORDER BY id DESC LIMIT 1`
	);
	assert.equal(
		(
			await post(operator, `/discussion/${slug}`, {
				title: '비공개 토론 주제',
				body: '비공개 토론 내용'
			})
		).status,
		200
	);
	assert.equal(
		(
			await post(operator, `/discussion/${slug}`, {
				intent: 'reply',
				threadId: publicThread.id,
				body: '비공개 상태의 답글'
			})
		).status,
		200
	);
	d = await current();
	await createFixtureProposal(query, slug, {
		version: d.version,
		content: '비공개 수정 제안',
		summary: '비공개 제안 사유'
	});
	const [proposal] = await query((tx) => tx`SELECT id FROM wv_proposals WHERE document_id=${d.id}`);
	await manageFixtureDocument(query, slug, {
		action: 'rename',
		title: 'historical-private-title',
		version: d.version,
		reviewed: 'yes'
	});
	d = await current();
	assert.equal(
		(
			await operator(`/history/${slug}?/restoreState`, {
				revision: initialRevision.id,
				version: d.version,
				reviewed: 'yes'
			})
		).status,
		303
	);
	assert.ok(
		!(await (await reader('/wiki/historical-private-title')).text()).includes('공개된 합성 안내'),
		'private later address remains restricted'
	);
	assert.ok(
		(await (await operator('/wiki/historical-private-title')).text()).includes('공개된 합성 안내'),
		'authorized operator can use preserved private address'
	);
	assert.equal(
		(await (await reader('/api/search?q=historical-private-title')).json()).length,
		0,
		'private former title is not a public search alias'
	);
	assert.equal(
		(await reader(`/wiki/${slug}?revision=${privateRevision.id}`)).status,
		404,
		'old private body does not become public'
	);
	assert.equal(
		(await reader(`/api/export/${slug}?revision=${privateRevision.id}`)).status,
		404,
		'Private historical export is blocked'
	);
	assert.equal(
		(await reader('/api/export/historical-private-title')).status,
		404,
		'Private preserved address cannot export'
	);
	const exported = await reader(`/api/export/${slug}`);
	assert.equal(exported.status, 200);
	assert.match(exported.headers.get('content-disposition'), /attachment/);
	const currentZip = await JSZip.loadAsync(await exported.arrayBuffer());
	assert.equal(await currentZip.file('document.md').async('string'), '공개된 합성 안내');
	const metadata = JSON.parse(await currentZip.file('metadata.json').async('string'));
	assert.equal(metadata.state.minRole, 'reader');
	assert.equal(metadata.state.title, slug);
	assert.equal(metadata.documentId, String(d.id));
	const privateExport = await operator(`/api/export/${slug}?revision=${privateRevision.id}`);
	assert.equal(privateExport.status, 200);
	const privateZip = await JSZip.loadAsync(await privateExport.arrayBuffer());
	assert.equal(await privateZip.file('document.md').async('string'), '비공개로 기록한 합성 본문');
	assert.equal(
		JSON.parse(await privateZip.file('metadata.json').async('string')).state.minRole,
		'admin'
	);
	assert.equal(
		(await reader(`/history/${slug}?diff=${privateRevision.id}`)).status,
		404,
		'private diff is blocked'
	);
	assert.equal(
		(await operator(`/wiki/${slug}?revision=${privateRevision.id}`)).status,
		200,
		'authorized operator retains access'
	);
	const discussion = await (await reader(`/discussion/${slug}?thread=${publicThread.id}`)).text();
	assert.ok(discussion.includes('공개 토론 주제'));
	assert.ok(!discussion.includes('비공개 토론 주제'));
	assert.ok(!discussion.includes('비공개 상태의 답글'));
	const proposals = await (await reader(`/proposals/${slug}?open=${proposal.id}`)).text();
	assert.ok(!proposals.includes('비공개 수정 제안'));
	assert.ok(!proposals.includes('비공개 제안 사유'));
	const alerts = await (await reader('/notifications')).text();
	assert.ok(
		!alerts.includes(`revision=${privateRevision.id}`),
		'private revision notification stays hidden'
	);
	console.log(
		'PASS historical access: making a document public does not expose old restricted revisions, diffs, proposals, threads, replies or notifications'
	);
}
