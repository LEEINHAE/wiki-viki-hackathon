import assert from 'node:assert/strict';
import { manageFixtureDocument } from './fixture-document-management.js';
export async function verifyRecovery({ query, editor, reader, operator }) {
	assert.equal(
		(
			await editor('/edit/recovery-fixture?/save', {
				title: 'recovery-fixture',
				content: '서버 복구 검증 문서',
				field: '일반'
			})
		).status,
		303
	);
	const [document] = await query(
		(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='recovery-fixture'`
	);
	const payload = {
		action: 'save',
		key: 'edit:recovery-fixture',
		kind: 'document',
		resources: [{ type: 'document', id: document.id }],
		values: {
			content: '저장 중이던 문장',
			version: document.version,
			reviewed: 'yes',
			password: 'never-store'
		},
		userId: '999999'
	};
	const post = (call, input) => call('/api/recovery', JSON.stringify(input));
	let response = await post(editor, payload);
	assert.equal(response.status, 200);
	let saved = await response.json();
	assert.ok(saved.version);
	let state = await (await editor('/api/recovery?key=edit:recovery-fixture')).json();
	assert.deepEqual(state.backup.values, { content: '저장 중이던 문장', version: document.version });
	assert.equal(
		(await (await reader('/api/recovery?key=edit:recovery-fixture')).json()).backup,
		null,
		'another account cannot read input'
	);
	assert.equal((await post(reader, { action: 'delete', key: payload.key })).status, 200);
	assert.ok(
		(await (await editor('/api/recovery?key=edit:recovery-fixture')).json()).backup,
		'another account cannot clear input'
	);
	assert.equal((await post(reader, payload)).status, 403, 'reader cannot save editor input');
	assert.equal(
		(await post(editor, payload)).status,
		409,
		'stale or missing recovery version cannot overwrite another tab'
	);
	assert.equal(
		(
			await post(editor, {
				...payload,
				version: saved.version,
				values: { content: 'person@example.com' }
			})
		).status,
		400,
		'sensitive text is not stored'
	);
	response = await post(editor, {
		...payload,
		version: saved.version,
		values: { content: '최신 미저장 문장', version: document.version }
	});
	assert.equal(response.status, 200);
	saved = await response.json();
	assert.equal(
		(await post(editor, { action: 'delete', key: payload.key, version: state.backup.version }))
			.status,
		409,
		'stale clear cannot remove newer input'
	);
	await manageFixtureDocument(query, 'recovery-fixture', {
		action: 'access',
		version: document.version,
		minRole: 'admin'
	});
	state = await (await editor('/api/recovery?key=edit:recovery-fixture')).json();
	assert.equal(state.backup, null, 'permission loss hides private recovery body');
	assert.equal(
		(await post(editor, { ...payload, version: saved.version })).status,
		403,
		'permission loss prevents further saves'
	);
	assert.equal(
		(await post(editor, { action: 'delete', key: payload.key, version: state.version })).status,
		200,
		'owner can clear inaccessible recovery'
	);
	assert.equal(
		(
			await post(editor, {
				...payload,
				key: 'edit:new-fixture',
				kind: 'new_document',
				resources: []
			})
		).status,
		200
	);
	await query(
		(tx) =>
			tx`UPDATE wv_recoveries SET expires_at=NOW()-interval '1 second' WHERE recovery_key='edit:new-fixture'`
	);
	assert.equal(
		(await (await editor('/api/recovery?key=edit:new-fixture')).json()).backup,
		null,
		'expired data cannot be restored'
	);
	assert.equal(
		(await query((tx) => tx`SELECT count(*)::int AS n FROM wv_recoveries`))[0].n,
		0,
		'expired rows are actually removed on access'
	);
	console.log(
		'PASS server recovery: account isolation, role/document access, approval/credential exclusion, blocked sensitive text, versioned save/delete, inaccessible-owner clear and expiry removal'
	);
}
