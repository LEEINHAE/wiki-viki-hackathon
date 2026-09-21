// Synthetic accounts and documents in a disposable schema; never modifies public.
import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { applyMigrations } from './migration-runner.js';
import { hashPassword } from '../src/lib/server/passwords.js';
import { verifyRecovery } from './recovery-checks.js';
import { verifyHistoricalAccess } from './historical-access-checks.js';
import { seedPrototype } from './prototype-seed.js';
import { manageFixtureDocument } from './fixture-document-management.js';
const schema = `wiki_test_auth_${Date.now()}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 5185);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid fixture port');
const base = `http://127.0.0.1:${port}`;
let server;
const query = (fn) =>
	admin.begin(async (tx) => {
		await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
		assert.equal((await tx`SELECT current_schema() AS name`)[0].name, schema);
		await tx`SELECT set_config('wv.operator','1',true)`;
		return fn(tx);
	});
const uiMode = process.argv.includes('--ui');
if (uiMode && !process.stdin.isTTY)
	throw Error(
		'UI preview requires an interactive terminal (tty=true) so Enter can clean up its fixture.'
	);
const password = uiMode ? 'WikiViki-disposable-fixture-2026' : randomBytes(24).toString('hex');
function client() {
	const jar = new Map();
	return async (path, values, origin = base) => {
		const res = await fetch(base + path, {
			method: values ? 'POST' : 'GET',
			headers: {
				cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
				...(values ? { origin } : {}),
				...(typeof values === 'string' ? { 'content-type': 'application/json' } : {}),
				accept: 'text/html'
			},
			body: typeof values === 'string' ? values : values ? new URLSearchParams(values) : undefined,
			redirect: 'manual'
		});
		for (const raw of res.headers.getSetCookie()) {
			const entry = raw.split(';')[0],
				index = entry.indexOf('=');
			jar.set(entry.slice(0, index), entry.slice(index + 1));
		}
		return res;
	};
}
try {
	// Never run fixture requests against a different process already on the port.
	await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(port, '127.0.0.1', () => probe.close(resolve));
	});
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await query(applyMigrations);
	const hash = await hashPassword(password);
	await query(async (tx) => {
		for (const [handle, role] of [
			['Editor-21', 'reader'],
			['Editor-22', 'editor'],
			['Editor-23', 'reviewer'],
			['Operator-24', 'admin']
		])
			await tx`INSERT INTO wv_users(handle,role,password_hash) VALUES(${handle},${role},${hash})`;
	});
	server = spawn(
		'bun',
		['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
		{
			env: {
				...process.env,
				// Automated auth checks stay offline; interactive previews use configured AI.
				OPENAI_API_KEY: uiMode ? process.env.OPENAI_API_KEY || '' : '',
				WIKI_TEST_SCHEMA: schema,
				WIKI_DEMO_MODE: '0',
				WIKI_CONTENT_POLICY: 'strict'
			},
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	server.stdout.on('data', () => {});
	server.stderr.on('data', (chunk) => {
		for (const line of chunk.toString().split('\n'))
			if (/^TypeError:|^ReferenceError:|session_check_failed/.test(line.trim()))
				console.log('Fixture render error:', line.trim());
	});
	for (let n = 0; n < 80; n++) {
		try {
			if ((await fetch(base + '/login')).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	const anonymous = client(),
		reader = client(),
		editor = client(),
		reviewer = client(),
		operator = client();
	for (const path of ['/', '/wiki/fixture', '/history/fixture', '/drafts'])
		assert.equal((await anonymous(path)).status, 303, path);
	for (const path of ['/api/search?q=fixture', '/api/uploads', '/api/export/fixture'])
		assert.equal((await anonymous(path)).status, 401, path);
	assert.equal((await anonymous('/api/answer', { q: 'fixture' })).status, 401);
	assert.equal((await anonymous('/edit/fixture?/save', { title: 'forged' })).status, 401);
	assert.equal(
		(await anonymous('/login', { handle: 'Editor-21', password }, 'https://wrong.example')).status,
		403
	);
	for (const [call, handle] of [
		[reader, 'Editor-21'],
		[editor, 'Editor-22'],
		[reviewer, 'Editor-23'],
		[operator, 'Operator-24']
	]) {
		const response = await call('/login', { handle, password });
		assert.equal(response.status, 303);
		assert.ok(
			response.headers
				.getSetCookie()
				.some((c) => c.includes('HttpOnly') && c.includes('SameSite=Lax'))
		);
	}
	assert.equal((await reader('/api/search?q=fixture')).status, 200);
	for (const path of [
		'/edit/fixture',
		'/drafts',
		'/uploads',
		'/api/uploads/chunks',
		'/admin/users',
		'/trash'
	])
		assert.equal((await reader(path)).status, 403, path);
	assert.equal((await editor('/drafts?/publish', { id: '1', reviewed: 'yes' })).status, 403);
	assert.equal((await reviewer('/edit/fixture?/delete', { version: 'x' })).status, 403);
	assert.equal((await editor('/api/wikify', {}, 'https://wrong.example')).status, 403);
	const saved = await editor('/edit/auth-fixture?/save', {
		title: 'auth-fixture',
		content: '권한 검증용 합성 본문',
		editor: 'Operator-24',
		summary: '권한 검증',
		field: '일반'
	});
	assert.equal(saved.status, 303);
	const [record] = await query(
		(tx) =>
			tx`SELECT d.editor_handle,r.actor_id,u.handle FROM documents d JOIN revisions r ON r.document_id=d.id JOIN wv_users u ON u.id=r.actor_id WHERE d.slug='auth-fixture'`
	);
	assert.equal(record.editor_handle, 'Editor-22');
	assert.equal(record.handle, 'Editor-22');
	assert.equal((await reader('/wiki/auth-fixture')).status, 200);
	for (const path of ['/proposals/auth-fixture', '/manage/auth-fixture', '/reviews']) {
		assert.equal((await operator(path)).status, 403, 'admin cannot open ' + path);
		assert.equal((await operator(path, {})).status, 403, 'admin cannot submit ' + path);
		assert.equal((await reviewer(path)).status, 200, 'reviewer keeps ' + path);
	}
	for (const action of ['create', 'decide'])
		assert.equal((await operator('/proposals/auth-fixture?/' + action, {})).status, 403);
	assert.equal((await operator('/admin/users')).status, 200);
	const adminArticle = await (await operator('/wiki/auth-fixture')).text();
	assert.ok(!adminArticle.includes('href="/proposals/'));
	assert.ok(!adminArticle.includes('href="/manage/'));
	assert.ok(!adminArticle.includes('href="/reviews"'));
	console.log(
		'PASS administrator mode: removed review routes reject GET/POST; reviewer workflows and administrator account management remain available'
	);

	assert.equal(
		(await reader('/wiki/auth-fixture')).headers.get('cache-control'),
		'private, no-store'
	);
	const users = await query((tx) => tx`SELECT id,handle FROM wv_users`);
	const readerId = users.find((u) => u.handle === 'Editor-21').id,
		adminId = users.find((u) => u.handle === 'Operator-24').id;

	if (!process.argv.includes('--transitions') && !process.argv.includes('--recovery')) {
		const currentDocument = async () =>
			(
				await query(
					(tx) => tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='auth-fixture'`
				)
			)[0];
		assert.equal(
			(
				await reader('/discussion/auth-fixture', {
					title: '표현 수정 제안',
					body: '본문의 표현을 다듬으면 좋겠습니다.',
					editor: 'Operator-24'
				})
			).status,
			200
		);
		const thread = (
			await query(
				(tx) =>
					tx`SELECT id,updated_at::text AS version FROM discussions WHERE document_id=(SELECT id FROM documents WHERE slug='auth-fixture')`
			)
		)[0];
		assert.equal(
			(
				await editor('/discussion/auth-fixture', {
					intent: 'reply',
					threadId: thread.id,
					body: '수정안을 검토하겠습니다.'
				})
			).status,
			200
		);
		assert.equal(
			(
				await editor('/discussion/auth-fixture', {
					intent: 'resolve',
					threadId: thread.id,
					version: thread.version,
					status: 'resolved'
				})
			).status,
			403
		);
		let proposalBase = await currentDocument();
		assert.equal(
			(
				await reader('/proposals/auth-fixture?/create', {
					version: proposalBase.version,
					discussionId: thread.id,
					content: '권한 검증용 합성 본문\n\n작은 표현을 다듬었습니다.',
					summary: '표현 보완'
				})
			).status,
			303
		);
		let proposal = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM wv_proposals ORDER BY id DESC LIMIT 1`
			)
		)[0];
		assert.equal(
			(await query((tx) => tx`SELECT content FROM documents WHERE id=${proposalBase.id}`))[0]
				.content,
			'권한 검증용 합성 본문'
		);
		const decision = {
			id: proposal.id,
			version: proposal.version,
			decision: 'accepted',
			content: '권한 검증용 합성 본문\n\n검토자가 최종 표현을 다듬었습니다.',
			reviewed: 'yes',
			resolveThread: 'yes'
		};
		assert.equal((await editor('/proposals/auth-fixture?/decide', decision)).status, 403);
		assert.equal(
			(await reviewer('/proposals/auth-fixture?/decide', { ...decision, reviewed: '' })).status,
			400
		);
		assert.equal((await reviewer('/proposals/auth-fixture?/decide', decision)).status, 303);
		assert.equal((await reviewer('/proposals/auth-fixture?/decide', decision)).status, 409);
		const accepted = (
			await query(
				(tx) =>
					tx`SELECT p.status,p.decision_revision_id,t.status AS thread_status,t.resolution_revision_id,r.details FROM wv_proposals p JOIN discussions t ON t.id=p.discussion_id JOIN revisions r ON r.id=p.decision_revision_id WHERE p.id=${proposal.id}`
			)
		)[0];
		assert.equal(accepted.status, 'accepted');
		assert.equal(accepted.thread_status, 'resolved');
		assert.equal(accepted.decision_revision_id, accepted.resolution_revision_id);
		assert.equal(accepted.details.manuallyEdited, true);
		assert.equal(
			(
				await editor('/discussion/auth-fixture', {
					intent: 'reply',
					threadId: thread.id,
					body: '닫힌 토론 답글'
				})
			).status,
			409
		);
		proposalBase = await currentDocument();
		assert.equal(
			(
				await reader('/proposals/auth-fixture?/create', {
					version: proposalBase.version,
					content: '두 번째 제안 본문',
					summary: '검토 중 충돌'
				})
			).status,
			303
		);
		proposal = (
			await query(
				(tx) => tx`SELECT id,updated_at::text AS version FROM wv_proposals ORDER BY id DESC LIMIT 1`
			)
		)[0];
		assert.equal(
			(
				await editor('/edit/auth-fixture?/save', {
					id: proposalBase.id,
					version: proposalBase.version,
					title: 'auth-fixture',
					content: '권한 검증용 합성 본문\n\n다른 편집이 먼저 저장되었습니다.',
					editor: 'Editor-22',
					field: '일반'
				})
			).status,
			303
		);
		assert.equal(
			(
				await reviewer('/proposals/auth-fixture?/decide', {
					...decision,
					id: proposal.id,
					version: proposal.version
				})
			).status,
			409
		);
		assert.equal(
			(
				await reviewer('/proposals/auth-fixture?/decide', {
					id: proposal.id,
					version: proposal.version,
					decision: 'rejected',
					note: '최신 버전에서 다시 제안해 주세요.'
				})
			).status,
			303
		);
		assert.equal((await reviewer('/proposals/auth-fixture?open=' + proposal.id)).status, 200);
		console.log(
			'PASS collaboration: reader proposal leaves body unchanged, reviewer-only one-time approval, final edits/revision tracking, linked discussion resolution, reply permissions, stale proposal rejects and can be declined'
		);

		let document = await currentDocument();
		for (const action of ['visit', 'favorite', 'subscribe'])
			assert.equal(
				(
					await reader(
						'/api/personal',
						JSON.stringify({ action, documentId: document.id, value: true, userId: adminId })
					)
				).status,
				200
			);
		assert.equal((await (await reader('/api/personal')).json()).favorites.length, 1);
		assert.equal((await (await editor('/api/personal')).json()).favorites.length, 0);

		assert.equal(
			(
				await reviewer('/manage/auth-fixture', {
					action: 'review',
					version: document.version,
					ownerId: users.find((u) => u.handle === 'Editor-22').id,
					nextReviewOn: '2000-01-01',
					note: '합성 본문과 출처 확인',
					reviewed: 'yes'
				})
			).status,
			303
		);
		assert.equal((await query((tx) => tx`SELECT count(*)::int AS n FROM wv_reviews`))[0].n, 1);
		assert.ok(
			(await (await reader('/notifications')).text()).includes('auth-fixture'),
			'subscriber receives actual revision notice'
		);
		assert.ok(
			(await (await editor('/notifications')).text()).includes('auth-fixture'),
			'new owner receives review request'
		);
		assert.equal(
			(
				await query(
					(tx) =>
						tx`SELECT document_state->>'stateVersion' AS v FROM revisions ORDER BY id DESC LIMIT 1`
				)
			)[0].v,
			'3'
		);
		const duePage = await reviewer('/reviews');
		assert.equal(duePage.status, 200, 'due review page loads');
		assert.ok(
			(await duePage.text()).includes('auth-fixture'),
			'due review includes the synthetic document'
		);
		assert.equal(
			(await reviewer('/manage/auth-fixture', { action: 'ownership', version: document.version }))
				.status,
			409
		);
		document = await currentDocument();
		assert.equal(
			(
				await reviewer('/manage/auth-fixture', {
					action: 'access',
					version: document.version,
					minRole: 'admin'
				})
			).status,
			403
		);
		await manageFixtureDocument(query, 'auth-fixture', {
			action: 'access',
			version: document.version,
			minRole: 'admin'
		});
		assert.deepEqual(await (await reader('/api/search?q=auth-fixture')).json(), []);
		assert.equal((await reader('/history/auth-fixture')).status, 404);
		assert.deepEqual((await (await reader('/api/personal')).json()).favorites, []);
		assert.ok(
			!(await (await reader('/notifications')).text()).includes('auth-fixture'),
			'restricted document notices are hidden'
		);
		assert.ok(
			!(await (await reader('/wiki/auth-fixture')).text()).includes('권한 검증용 합성 본문')
		);
		assert.ok(!(await (await reader('/?view=activity')).text()).includes('auth-fixture'));
		assert.equal((await operator('/wiki/auth-fixture')).status, 200);
		assert.equal(
			(
				await editor('/edit/auth-fixture?/save', {
					id: document.id,
					version: document.version,
					title: 'auth-fixture',
					content: 'forged write',
					editor: 'Editor-22'
				})
			).status,
			409
		);
		document = await currentDocument();
		await manageFixtureDocument(query, 'auth-fixture', {
			action: 'access',
			version: document.version,
			minRole: 'reader'
		});
		document = await currentDocument();
		assert.equal(
			(
				await reviewer('/manage/auth-fixture', {
					action: 'archive',
					version: document.version,
					archived: 'yes'
				})
			).status,
			303
		);
		assert.deepEqual(await (await reader('/api/search?q=auth-fixture')).json(), []);
		assert.deepEqual(await (await operator('/api/search?q=auth-fixture')).json(), []);
		assert.ok(
			!(await (await reader('/wiki/auth-fixture')).text()).includes('권한 검증용 합성 본문')
		);
		document = await currentDocument();
		assert.equal(
			(
				await reviewer('/manage/auth-fixture', {
					action: 'archive',
					version: document.version,
					archived: 'no'
				})
			).status,
			303
		);
		assert.equal((await (await reader('/api/search?q=auth-fixture')).json()).length, 1);
		assert.equal(
			(await reader('/api/personal', JSON.stringify({ action: 'clear', userId: adminId }))).status,
			200
		);
		assert.equal((await (await reader('/api/personal')).json()).favorites.length, 0);
		assert.ok(
			(await (await editor('/notifications')).text()).includes('auth-fixture'),
			'clearing one account preserves another account notifications'
		);
		console.log(
			'PASS account personalization: IDs cannot impersonate another user, favorites and recent sync, actual subscription/owner notices, access filtering, account-only clear'
		);
		console.log(
			'PASS document access/lifecycle: restricted and archived documents leave search/history/activity, stale metadata rejects, review records link to full snapshot, due list, reviewer cannot change access'
		);
		assert.equal(
			(
				await editor('/edit/collection-second?/save', {
					title: 'collection-second',
					content: '문서 묶음 검증용 본문',
					field: '일반'
				})
			).status,
			303
		);
		const collectionInput = {
			title: '내 업무 순서',
			description: '문서 묶음 검증',
			documents: 'collection-second\nauth-fixture'
		};
		assert.equal((await reader('/collections?/save', collectionInput)).status, 303);
		let collection = (
			await query(
				(tx) =>
					tx`SELECT id,updated_at::text AS version FROM wv_collections WHERE owner_id=${readerId}`
			)
		)[0];
		assert.equal(
			(await editor('/collections?open=' + collection.id)).status,
			404,
			'private collection stays private'
		);
		assert.equal(
			(
				await editor('/collections?/save', {
					...collectionInput,
					id: collection.id,
					version: collection.version
				})
			).status,
			403,
			'only owner can edit'
		);
		assert.equal(
			(
				await reader('/collections?/save', {
					...collectionInput,
					id: collection.id,
					version: collection.version,
					shared: 'yes'
				})
			).status,
			303
		);
		assert.equal(
			(
				await reader('/collections?/save', {
					...collectionInput,
					id: collection.id,
					version: collection.version
				})
			).status,
			409,
			'stale collection rejects'
		);
		let collectionPage = await editor('/collections?open=' + collection.id);
		assert.equal(collectionPage.status, 200);
		assert.ok((await collectionPage.text()).includes('collection-second'));
		assert.deepEqual(
			(
				await query(
					(tx) =>
						tx`SELECT d.slug FROM wv_collection_items i JOIN documents d ON d.id=i.document_id WHERE i.collection_id=${collection.id} ORDER BY position`
				)
			).map((d) => d.slug),
			['collection-second', 'auth-fixture']
		);
		const second = (
			await query(
				(tx) =>
					tx`SELECT id,updated_at::text AS version FROM documents WHERE slug='collection-second'`
			)
		)[0];
		await manageFixtureDocument(query, 'collection-second', {
			action: 'access',
			version: second.version,
			minRole: 'admin'
		});
		collection = (
			await query(
				(tx) =>
					tx`SELECT id,updated_at::text AS version FROM wv_collections WHERE owner_id=${readerId}`
			)
		)[0];
		collectionPage = await editor('/collections?open=' + collection.id);
		assert.ok(
			!(await collectionPage.text()).includes('collection-second'),
			'shared collection filters private document titles'
		);
		const editedCollection = {
			...collectionInput,
			id: collection.id,
			version: collection.version,
			documents: 'auth-fixture',
			shared: 'yes'
		};
		assert.equal(
			(await reader('/collections?/save', editedCollection)).status,
			409,
			'invisible items are not silently removed'
		);
		assert.equal(
			(await reader('/collections?/save', { ...editedCollection, dropUnavailable: 'yes' })).status,
			303
		);
		assert.equal(
			(
				await query(
					(tx) =>
						tx`SELECT count(*)::int AS n FROM wv_collection_items WHERE collection_id=${collection.id}`
				)
			)[0].n,
			1
		);
		console.log(
			'PASS collections: owner-only editing, private/shared visibility, explicit order, stale update rejection, permission filtering and explicit removal of unavailable items'
		);
	}
	if (!process.argv.includes('--recovery')) {
		for (const [title, content, aliases, tags] of [
			['merge-source', '원본 문서 본문', 'old-source', '원본'],
			['merge-target', '대상 문서 본문', '', '대상'],
			['merge-link', '연결 검증 [[old-source]]', '', '']
		])
			assert.equal(
				(await editor(`/edit/${title}?/save`, { title, content, aliases, tags, field: '설비' }))
					.status,
				303
			);
		const documentBySlug = async (slug) =>
			(
				await query(
					(tx) =>
						tx`SELECT id,title,content,wv_min_role,wv_merged_into,updated_at::text AS version FROM documents WHERE slug=${slug}`
				)
			)[0];
		const initialTarget = (
			await query(
				(tx) =>
					tx`SELECT r.id,r.content,r.document_state FROM revisions r JOIN documents d ON d.id=r.document_id WHERE d.slug='merge-target' ORDER BY r.id LIMIT 1`
			)
		)[0];
		let source = await documentBySlug('merge-source'),
			target = await documentBySlug('merge-target');
		const rename = {
			action: 'rename',
			title: 'renamed-target',
			version: target.version,
			reviewed: 'yes'
		};
		assert.equal((await editor('/manage/merge-target', rename)).status, 403);
		assert.equal(
			(await reviewer('/manage/merge-target', { ...rename, title: 'merge-source' })).status,
			409,
			'rename cannot steal title'
		);
		assert.equal((await reviewer('/manage/merge-target', rename)).status, 303);
		assert.equal(
			(await reviewer('/manage/merge-target', rename)).status,
			409,
			'stale rename rejects'
		);
		assert.ok((await (await reader('/wiki/renamed-target')).text()).includes('renamed-target'));
		assert.equal(
			(await reader('/wiki/merge-target')).status,
			200,
			'old canonical URL works after rename'
		);
		await manageFixtureDocument(query, 'merge-source', {
			action: 'access',
			version: source.version,
			minRole: 'editor'
		});
		source = await documentBySlug('merge-source');
		target = await documentBySlug('merge-target');
		const beforeSource = (
			await query(
				(tx) =>
					tx`SELECT id,document_state FROM revisions WHERE document_id=${source.id} ORDER BY id DESC LIMIT 1`
			)
		)[0];
		const merge = {
			sourceVersion: source.version,
			targetVersion: target.version,
			targetSlug: 'merge-target',
			content: '두 문서의 검토한 최종 본문',
			tags: '원본, 대상',
			note: '중복 문서 정리',
			reviewed: 'yes'
		};
		assert.equal((await editor('/merge/merge-source', merge)).status, 403);
		assert.equal(
			(
				await reviewer('/merge/merge-source', {
					...merge,
					sourceVersion: initialTarget.document_state.updatedAt || '2000-01-01'
				})
			).status,
			409
		);
		assert.equal((await reviewer('/merge/merge-source?target=merge-target')).status, 200);
		assert.equal((await reviewer('/merge/merge-source', merge)).status, 303);
		assert.equal(
			(await reviewer('/merge/merge-source', merge)).status,
			409,
			'merge retries do not duplicate'
		);
		source = await documentBySlug('merge-source');
		target = await documentBySlug('merge-target');
		assert.equal(String(source.wv_merged_into), String(target.id));
		assert.equal(source.content, '원본 문서 본문');
		assert.equal(target.content, merge.content);
		assert.equal(target.wv_min_role, 'editor');
		assert.ok(
			!(await (await reader('/wiki/merge-target')).text()).includes(merge.content),
			'merged content stays within stricter audience'
		);
		const mergedPage = await editor('/wiki/old-source');
		assert.equal(mergedPage.status, 200);
		assert.ok((await mergedPage.text()).includes(merge.content));
		assert.equal(
			(await editor('/wiki/merge-source?revision=' + beforeSource.id)).status,
			200,
			'original revision URL remains readable'
		);
		assert.equal((await editor('/history/merge-source')).status, 200, 'source history survives');
		assert.ok(
			(await (await editor('/api/search?q=old-source')).json()).some(
				(row) => String(row.id) === String(target.id)
			),
			'source alias resolves to merged target in search'
		);
		assert.equal(
			(
				await query(
					(tx) =>
						tx`SELECT count(*)::int AS n FROM wv_link_edges WHERE source_slug='merge-link' AND target_id=${target.id}`
				)
			)[0].n,
			1,
			'old source links resolve to target'
		);
		const restore = { revision: initialTarget.id, version: target.version, reviewed: 'yes' };
		assert.equal((await reviewer('/history/merge-target?/restoreState', restore)).status, 403);
		assert.equal(
			(await operator('/history/merge-target?restore=' + initialTarget.id)).status,
			200,
			'full state preview renders'
		);
		assert.equal((await operator('/history/merge-target?/restoreState', restore)).status, 303);
		assert.equal(
			(await operator('/history/merge-target?/restoreState', restore)).status,
			409,
			'restore retry creates no duplicate'
		);
		assert.deepEqual(
			(await query((tx) => tx`SELECT wv_document_state_v1(${target.id}::bigint) AS state`))[0]
				.state,
			initialTarget.document_state,
			'all recorded document metadata restores exactly'
		);
		assert.equal((await documentBySlug('merge-target')).content, initialTarget.content);
		assert.ok(
			(await (await reader('/wiki/renamed-target')).text()).includes(initialTarget.content),
			'later alias remains as preserved address'
		);
		assert.equal(
			(
				await editor('/edit/cannot-steal?/save', {
					title: 'renamed-target',
					content: '주소 가로채기 시도',
					field: '일반'
				})
			).status,
			409,
			'preserved address cannot be stolen'
		);
		assert.equal(
			(
				await operator('/history/merge-source?/restoreState', {
					revision: beforeSource.id,
					version: source.version,
					reviewed: 'yes'
				})
			).status,
			303
		);
		assert.equal(
			(await documentBySlug('merge-source')).wv_merged_into,
			null,
			'source can be restored without changing target history'
		);
		assert.equal((await editor('/wiki/old-source')).status, 200);
		console.log(
			'PASS document transitions: rename keeps URLs, merge preserves both histories/aliases/links and stricter audience, stale/retry rejection, admin-only full metadata/body restore and later-address preservation'
		);
	}
	await verifyRecovery({ query, editor, reader, operator });
	await verifyHistoricalAccess({ query, reader, editor, operator });
	assert.equal(
		(await operator('/admin/users?/access', { id: readerId, role: 'editor', active: 'yes' }))
			.status,
		303
	);
	assert.equal(
		(await reader('/api/search?q=fixture')).status,
		401,
		'role changes revoke existing session'
	);
	assert.equal((await reader('/login', { handle: 'Editor-21', password })).status, 303);
	assert.equal((await reader('/edit/auth-fixture')).status, 200);
	assert.equal(
		(await operator('/admin/users?/access', { id: adminId, role: 'reader', active: 'yes' })).status,
		409,
		'last admin remains'
	);
	assert.equal(
		(await operator('/admin/users?/access', { id: readerId, role: 'editor' })).status,
		303
	);
	assert.equal((await reader('/api/search?q=fixture')).status, 401);
	assert.equal(
		(await reader('/login', { handle: 'Editor-21', password })).status,
		400,
		'disabled account cannot sign in'
	);
	assert.equal((await editor('/logout', {})).status, 303);
	assert.equal((await editor('/api/search?q=fixture')).status, 401);
	await query(
		(tx) =>
			tx`UPDATE wv_sessions SET expires_at=NOW()-interval '1 second' WHERE user_id=${users.find((u) => u.handle === 'Editor-23').id}`
	);
	assert.equal((await reviewer('/api/search?q=fixture')).status, 401, 'expired sessions rejected');
	let limited;
	for (let n = 0; n < 11; n++) {
		limited = await anonymous('/login', { handle: 'Editor-99', password });
		if (limited.status === 429) break;
	}
	assert.equal(limited.status, 429);
	console.log(
		'PASS auth HTTP: default closed, read/edit/review/admin gates, origin protection, actor spoof rejected, cookie flags, account disable/role/logout/expiry revocation, last admin, login limit'
	);
	if (uiMode) {
		await query(async (tx) => {
			await tx`UPDATE wv_users SET active=true,role=CASE WHEN handle='Editor-21' THEN 'reader' ELSE role END`;
			await tx`DELETE FROM wv_login_limits`;
			await seedPrototype(tx);
		});
		console.log(
			`UI fixture ready: ${base}/login · Operator-24 / Editor-23 / Editor-22 / Editor-21 · synthetic password: ${password}`
		);
		console.log('Press Enter to finish the disposable UI session and remove its schema.');
		await new Promise((resolve) => {
			process.stdin.once('data', () => {
				process.stdin.pause();
				resolve();
			});
			process.stdin.resume();
		});
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
