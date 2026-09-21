import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

// All writes use the calling harness's disposable schema and synthetic browser owner.
export async function checkUploadTransfers({ base, query }) {
	let cookie = '';
	const call = async (path, body, type = 'application/json', owner = cookie) => {
		const response = await fetch(base + path, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { origin: base, cookie: owner, 'content-type': type },
			body:
				body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body
		}).catch((cause) => {
			throw new Error(
				`Transfer request failed: ${body === undefined ? 'GET' : 'POST'} ${path.split('?')[0]} ${type} bytes=${body?.byteLength ?? 0}`,
				{ cause }
			);
		});
		const set = response.headers.getSetCookie();
		if (set.length && owner === cookie) cookie = set.map((s) => s.split(';')[0]).join('; ');
		return response;
	};
	const start = async (
		bytes,
		name = 'transport-fixture.docx',
		hash = createHash('sha256').update(bytes).digest('hex')
	) => {
		const response = await call('/api/uploads/chunks', { name, size: bytes.length, hash });
		assert.equal(response.status, 200, await response.clone().text());
		return response.json();
	};
	const part = (token, index, bytes, owner = cookie) =>
		call(
			`/api/uploads/chunks?token=${token}&part=${index}`,
			bytes,
			'application/octet-stream',
			owner
		);
	const finish = async (token) => {
		const form = new FormData();
		form.set('uploadToken', token);
		form.set('editor', 'Editor-01');
		form.set('basic', 'true');
		return fetch(base + '/api/wikify', {
			method: 'POST',
			headers: { origin: base, cookie },
			body: form
		});
	};
	const unit = 1024 * 1024;
	const bytes = Buffer.alloc(unit + 7, 65);
	const first = await start(bytes);
	const bufferId = (
		await query((tx) => tx`SELECT id FROM wv_upload_buffers WHERE token=${first.token}`)
	)[0].id;
	assert.equal(first.parts, 2);
	assert.equal((await part(first.token, 0, bytes.subarray(0, unit))).status, 200);
	assert.equal((await part(first.token, 0, bytes.subarray(0, unit))).status, 200);
	assert.equal((await part(first.token, 0, Buffer.alloc(unit, 66))).status, 409);
	assert.equal((await part(first.token, 1, Buffer.alloc(8))).status, 400);
	assert.equal((await part(first.token, 2, Buffer.alloc(1))).status, 400);
	assert.equal((await part(first.token, 1, bytes.subarray(unit), '')).status, 404);
	assert.equal(
		(await call(`/api/uploads/chunks?token=${first.token}`, undefined, 'application/json', ''))
			.status,
		404
	);
	assert.deepEqual(
		await (await call('/api/uploads/chunks', undefined, 'application/json', '')).json(),
		[]
	);
	const resumed = await start(bytes);
	assert.equal(resumed.token, first.token);
	assert.deepEqual(resumed.received, [0]);
	assert.equal((await finish(first.token)).status, 409);
	assert.equal((await part(first.token, 1, bytes.subarray(unit))).status, 200);
	assert.equal((await part(first.token, 1, Buffer.alloc(unit + 1))).status, 413);
	assert.equal(
		(
			await call('/api/uploads/chunks', {
				name: 'large.docx',
				size: 10 * unit + 1,
				hash: 'a'.repeat(64)
			})
		).status,
		413
	);
	assert.equal(
		(
			await call('/api/uploads/chunks', {
				name: 'person@example.com.docx',
				size: 1,
				hash: 'a'.repeat(64)
			})
		).status,
		400
	);
	await start(Buffer.from('b'), 'two.docx');
	await start(Buffer.from('c'), 'three.docx');
	assert.equal(
		(await call('/api/uploads/chunks', { name: 'four.docx', size: 1, hash: 'a'.repeat(64) }))
			.status,
		429
	);
	await query(
		(tx) =>
			tx`UPDATE wv_upload_buffers SET expires_at=NOW()-interval '1 second' WHERE token=${first.token}`
	);
	assert.equal((await call(`/api/uploads/chunks?token=${first.token}`)).status, 404);
	assert.equal(
		(
			await query(
				(tx) => tx`SELECT count(*)::int AS n FROM wv_upload_parts WHERE buffer_id=${bufferId}`
			)
		)[0].n,
		0
	);
	for (const transfer of await (await call('/api/uploads/chunks')).json())
		assert.equal(
			(await call('/api/uploads/chunks', { action: 'discard', token: transfer.token })).status,
			200
		);
	assert.deepEqual(await (await call('/api/uploads/chunks')).json(), []);
	const wrongHash = await start(Buffer.from('a'), 'bad-hash.docx', 'b'.repeat(64));
	assert.equal((await part(wrongHash.token, 0, Buffer.from('a'))).status, 200);
	assert.equal((await finish(wrongHash.token)).status, 409);
	assert.equal((await call(`/api/uploads/chunks?token=${wrongHash.token}`)).status, 404);

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
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>분할 전송 검증 안내</w:t></w:r></w:p><w:p><w:r><w:t>안전한 합성 자료이며 기본 초안을 검토한 뒤 게시합니다.</w:t></w:r></w:p></w:body></w:document>'
	);
	zip.file('word/media/synthetic-padding.bin', Buffer.alloc(9.5 * unit));
	const document = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	assert.ok(document.length > 9.5 * unit && document.length < 10 * unit);
	const large = await start(document, 'large-transport-fixture.docx');
	for (let i = 0; i < large.parts; i++)
		assert.equal(
			(await part(large.token, i, document.subarray(i * unit, (i + 1) * unit))).status,
			200
		);
	const completed = await finish(large.token);
	assert.equal(completed.status, 200);
	const events = (await completed.text()).trim().split('\n').map(JSON.parse);
	const result = events.find((e) => e.type === 'done');
	assert.ok(result, JSON.stringify(events));
	assert.equal(result.mode, 'basic');
	assert.equal(result.drafts.length, 1);
	assert.equal((await call(`/api/uploads/chunks?token=${large.token}`)).status, 404);
	assert.equal((await query((tx) => tx`SELECT count(*)::int AS n FROM wv_upload_parts`))[0].n, 0);
	const rows = await query(
		(tx) => tx`SELECT d.content,d.governance FROM drafts d WHERE d.id=${result.drafts[0].id}`
	);
	assert.match(rows[0].content, /분할 전송 검증 안내/);
	assert.equal(rows[0].governance.aiGenerated, false);
	console.log(
		`PASS chunk transfer: ${document.length} bytes / ${large.parts} bounded requests, resume, owner isolation, exact parts, digest, expiry, cancellation, limit and source extraction`
	);
}
