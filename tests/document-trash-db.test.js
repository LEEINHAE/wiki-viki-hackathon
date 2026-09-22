import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, copyFile, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { seedAIResponse } from './fixtures/seed-source.js';

test(
	'document trash and recovery with isolated PostgreSQL',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1', timeout: 60000 },
	async (t) => {
		const lib = fileURLToPath(new URL('../src/lib', import.meta.url)),
			fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
		const server = await createServer({
			configFile: false,
			envDir: false,
			server: { middlewareMode: true, ws: false, watch: null },
			resolve: { alias: { $lib: lib } },
			plugins: [
				{
					name: 'isolated-trash',
					enforce: 'pre',
					resolveId(id) {
						if (id === '$env/dynamic/private' || id === `${lib}/server/db.js` || id === './db.js')
							return fixture;
					}
				}
			]
		});
		const state = await server.ssrLoadModule(fixture);
		try {
			await state.setupDatabase({ maxConnections: 8 });
			const sql = state.db();
			const edit = await server.ssrLoadModule('/src/routes/edit/[slug]/+page.server.js'),
				trash = await server.ssrLoadModule('/src/routes/trash/+page.server.js'),
				history = await server.ssrLoadModule('/src/routes/history/[slug]/+page.server.js'),
				discussion = await server.ssrLoadModule('/src/routes/discussion/[slug]/+page.server.js');
			const home = await server.ssrLoadModule('/src/routes/+page.server.js'),
				reader = await server.ssrLoadModule('/src/routes/wiki/[slug]/+page.server.js'),
				search = await server.ssrLoadModule('/src/lib/server/search.js'),
				wiki = await server.ssrLoadModule('/src/lib/server/wiki.js'),
				writer = await server.ssrLoadModule('/src/lib/server/document-write.js');
			const lifecycle = await server.ssrLoadModule('/src/lib/server/document-trash.js'),
				answer = await server.ssrLoadModule('/src/routes/api/answer/+server.js'),
				suggest = await server.ssrLoadModule('/src/routes/api/search/+server.js'),
				drafts = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			const slug = '원본-장비',
				alias = 'legacy-equipment';
			async function seed() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
				const [doc] =
					await sql`INSERT INTO documents(slug,title,content,editor_handle,updated_at) VALUES (${slug},'원본 장비','# 보관 전 본문\n\n[[남은 문서]]','Editor-42','2026-09-20 12:34:56.123456+00') RETURNING *`;
				const [revision] =
					await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES (${doc.id},'이전 본문','Editor-01','[AI 통합 · 새 초안 우선] 기존 내용 보존') RETURNING *`;
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES (${alias},'장비, 이전 이름',${doc.id})`;
				await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES (${doc.id},'기존 토론','기존 의견','Editor-42')`;
				const [draft] =
					await sql`INSERT INTO drafts(title,slug,content,governance,status) VALUES ('원본 장비',${slug},'기존 게시 초안','{"published":{"slug":"원본-장비"},"merge":{"id":"preserved"}}','published') RETURNING *`;
				const [other] =
					await sql`INSERT INTO documents(slug,title,content) VALUES ('남은-문서','남은 문서','[[원본 장비]]로 이어지는 기록') RETURNING *`;
				return { doc, revision, draft, other };
			}
			async function snapshot() {
				const [row] =
					await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) AS data`;
				return row.data;
			}
			async function fields(route = slug) {
				const data = await edit.load({ params: { slug: route } });
				return {
					documentId: String(data.document?.id || ''),
					version: data.version,
					editor: 'Editor-42',
					title: '작성 중 제목',
					content: '작성 중 본문',
					summary: '작성 중 요약',
					aliases: '수정 중 별칭',
					aliasesFormat: 'lines',
					confirmDelete: 'yes'
				};
			}
			async function restoredFields(id) {
				const data = await trash.load({ url: new URL('http://localhost/trash?open=' + id) });
				return { documentId: String(id), version: data.selected.version };
			}
			async function post(action, values, route = slug) {
				const body = new FormData();
				for (const [key, value] of Object.entries(values)) body.set(key, String(value));
				try {
					return await action({
						params: { slug: route },
						request: new Request('http://localhost/action', { method: 'POST', body })
					});
				} catch (error) {
					if (error.status === 303) return { status: 303, location: error.location };
					throw error;
				}
			}
			async function move(id, deleted) {
				const expected = await writer.getEditableDocument('', id, { includeDeleted: true });
				return lifecycle.changeDocumentTrash({ expected, deleted, editor: 'Editor-42' });
			}
			function preservedExceptLifecycle(after, before, id) {
				for (const key of ['revisions', 'aliases', 'discussions', 'drafts'])
					assert.deepEqual(after[key], before[key]);
				const normalize = (rows) =>
					rows.map((d) => {
						const row = { ...d };
						if (String(row.id) === String(id)) {
							delete row.deleted_at;
							delete row.deleted_by;
							delete row.lifecycle_version;
						}
						return row;
					});
				assert.deepEqual(normalize(after.documents), normalize(before.documents));
			}
			async function overlap(jobs) {
				const ready = Promise.withResolvers(),
					release = Promise.withResolvers();
				const gate = sql.begin(async (tx) => {
					await tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`;
					ready.resolve();
					await release.promise;
				});
				gate.catch(ready.reject);
				const pending = [];
				try {
					await ready.promise;
					for (const job of jobs) {
						const p = job();
						p.catch(() => {});
						pending.push(p);
					}
					let reached = false;
					const end = Date.now() + 4000;
					while (Date.now() < end) {
						const rows =
							await sql`SELECT pid FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND state='active' AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE documents, redirects%'`;
						if (new Set(rows.map((r) => r.pid)).size === jobs.length) {
							reached = true;
							break;
						}
						await delay(20);
					}
					assert.equal(reached, true, 'separate backends must reach the write lock');
				} finally {
					release.resolve();
					await Promise.all([gate, ...pending]);
				}
				return Promise.all(pending);
			}

			await t.test(
				'confirmed deletion and restoration preserve document identity, precise edit time and every relationship',
				async (st) => {
					const { doc } = await seed(),
						before = await snapshot(),
						input = await fields(alias);
					let calls = 0;
					st.mock.method(globalThis, 'fetch', () => {
						calls++;
						throw new Error('No external calls allowed');
					});
					const deleted = await post(edit.actions.delete, input, alias);
					assert.equal(deleted.location, '/trash?open=' + doc.id);
					const archived = await snapshot();
					preservedExceptLifecycle(archived, before, doc.id);
					assert.ok(archived.documents[0].deleted_at);
					assert.equal(archived.documents[0].deleted_by, 'Editor-42');
					assert.equal(archived.documents[0].lifecycle_version, 1);
					const data = await trash.load({ url: new URL('http://localhost/trash?open=' + doc.id) });
					assert.equal(data.documents.length, 1);
					assert.equal(data.selected.document.content, doc.content);
					assert.equal(data.selected.aliases[0].alias_slug, alias);
					const reviewed = await restoredFields(doc.id);
					assert.equal(
						(await post(trash.actions.restore, reviewed)).location,
						'/wiki/' + encodeURIComponent(slug)
					);
					const restored = await snapshot();
					preservedExceptLifecycle(restored, before, doc.id);
					assert.equal(restored.documents[0].deleted_at, null);
					assert.equal(restored.documents[0].deleted_by, null);
					assert.equal(restored.documents[0].lifecycle_version, 2);
					assert.equal(calls, 0);
					assert.equal((await post(trash.actions.restore, reviewed)).status, 409);
					assert.equal((await post(edit.actions.delete, input)).status, 409);
					assert.deepEqual(await snapshot(), restored);
				}
			);
			await t.test(
				'archived content is excluded from public read/edit/history/discussion/search/AI and graph queries',
				async (st) => {
					const { doc, other } = await seed();
					await move(doc.id, true);
					state.env.OPENAI_API_KEY = 'test-only-key';
					let calls = 0;
					st.mock.method(globalThis, 'fetch', () => {
						calls++;
						throw new Error('Archived context must not leave');
					});
					for (const route of [slug, alias]) {
						assert.equal(await wiki.getDocument(route), null);
						assert.equal(await writer.getEditableDocument(route), null);
						const editData = await edit.load({ params: { slug: route } });
						assert.equal(editData.document, null);
						assert.equal(String(editData.trashed.id), String(doc.id));
						assert.doesNotMatch(JSON.stringify(editData), /보관 전 본문|이전 본문/);
						const page = await reader.load({ params: { slug: route } });
						assert.equal(page.trashed, true);
						assert.doesNotMatch(JSON.stringify(page), /보관 전 본문|이전 본문/);
						await assert.rejects(
							history.load({ params: { slug: route }, url: new URL('http://localhost/history') }),
							{ status: 404 }
						);
						await assert.rejects(discussion.load({ params: { slug: route } }), { status: 404 });
					}
					assert.equal((await search.searchDocuments('보관 전 본문')).length, 0);
					assert.equal((await search.suggestions('이전 이름')).length, 0);
					assert.equal(
						(await wiki.recentChanges()).some((d) => d.slug === slug),
						false
					);
					const searchResponse = await suggest.GET({
						url: new URL('http://localhost/api/search?q=' + encodeURIComponent('이전 이름'))
					});
					assert.deepEqual((await searchResponse.json()).results, []);
					const response = await answer.POST({
						request: new Request('http://localhost/api/answer', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ q: '이전 이름' })
						})
					});
					assert.equal((await response.json()).status, 'empty');
					assert.equal(calls, 0);
					const homeData = await home.load({
						url: new URL('http://localhost/?q=' + encodeURIComponent('보관 전 본문'))
					});
					assert.equal(homeData.databaseReady, true);
					assert.equal(homeData.stats.documents, 1);
					assert.equal(homeData.stats.edits, 0);
					assert.equal(homeData.discussions.length, 0);
					assert.equal(homeData.results.length, 0);
					assert.equal(
						homeData.graph.nodes.some((d) => d.slug === slug),
						false
					);
					const remaining = await reader.load({ params: { slug: other.slug } });
					assert.equal(remaining.related.length, 0);
					assert.equal(remaining.backlinks.length, 0);
					assert.match(remaining.html, /wiki-link missing/);
					assert.match(await wiki.renderWiki('[[legacy-equipment]]'), /wiki-link missing/);
					assert.equal(await wiki.autoLinkDocument('원본 장비', ['원본 장비']), '원본 장비');
					await move(doc.id, false);
					assert.ok(await wiki.getDocument(alias));
					assert.ok((await search.searchDocuments('보관 전 본문')).length);
					assert.match(await wiki.renderWiki('[[원본 장비]]'), /class="wiki-link "/);
				}
			);
			await t.test(
				'confirmation, malformed IDs and unreviewed deletion fail with original editor input intact',
				async () => {
					await seed();
					const input = await fields(),
						before = await snapshot();
					for (const change of [
						{ confirmDelete: '' },
						{ version: '' },
						{ documentId: '0' },
						{ documentId: '9223372036854775808' },
						{ editor: 'person@example.invalid' }
					]) {
						const submitted = { ...input, ...change },
							result = await post(edit.actions.delete, submitted);
						assert.equal(result.status, 400);
						for (const key of [
							'title',
							'content',
							'summary',
							'aliases',
							'version',
							'documentId',
							'editor'
						])
							assert.equal(result.data[key], submitted[key]);
						assert.deepEqual(await snapshot(), before);
					}
				}
			);
			for (const mutation of ['body', 'alias', 'retarget', 'roundtrip'])
				await t.test(`stale deletion after ${mutation} does not hide changed data`, async () => {
					const { doc, other } = await seed(),
						input = await fields(alias);
					if (mutation === 'body')
						await sql`UPDATE documents SET content='새 본문' WHERE id=${doc.id}`;
					if (mutation === 'alias')
						await sql`UPDATE redirects SET alias_title='바뀐 이름' WHERE document_id=${doc.id}`;
					if (mutation === 'retarget') await sql`UPDATE redirects SET document_id=${other.id}`;
					if (mutation === 'roundtrip') {
						await move(doc.id, true);
						await move(doc.id, false);
					}
					const before = await snapshot(),
						result = await post(edit.actions.delete, input, alias);
					assert.equal(result.status, 409);
					assert.equal(result.data.deleteReviewRequired, true);
					assert.equal(result.data.content, input.content);
					assert.deepEqual(await snapshot(), before);
				});
			await t.test(
				'deleted titles and all stored addresses remain reserved for direct editing and draft publication',
				async () => {
					const { doc } = await seed();
					await move(doc.id, true);
					const archived = await snapshot();
					for (const values of [
						{ title: '원본 장비', aliases: '' },
						{ title: '다른 새 문서', aliases: alias },
						{ title: '다른 새 문서', aliases: '원본 장비' }
					]) {
						const result = await post(
							edit.actions.save,
							{ ...(await fields('new')), ...values, content: '새로운 본문', editor: 'Editor-01' },
							'new'
						);
						assert.equal(result.status, 409);
						assert.deepEqual(await snapshot(), archived);
					}
					const [draft] =
						await sql`INSERT INTO drafts(title,slug,content) VALUES('원본 장비',${slug},'다른 초안') RETURNING *`;
					const loaded = await drafts.load({
						url: new URL('http://localhost/drafts?open=' + draft.id)
					});
					const selected = loaded.selected;
					const before = await snapshot();
					const result = await post(drafts.actions.publish, {
						id: draft.id,
						version: selected.version
					});
					assert.equal(result.status, 409);
					const after = await snapshot();
					const expected = structuredClone(before);
					const expectedDraft = expected.drafts.find((d) => String(d.id) === String(draft.id));
					expectedDraft.status = 'blocked';
					expectedDraft.updated_at = after.drafts.find(
						(d) => String(d.id) === String(draft.id)
					).updated_at;
					expectedDraft.governance = {
						passed: true,
						regex: { passed: true, reasons: [] },
						semantic: { passed: true, reasons: [], skipped: true },
						fields: [],
						publication: { code: 'conflict' }
					};
					assert.deepEqual(after, expected);
				}
			);
			for (const archived of [false, true]) {
				for (const collision of ['title-alias-label', 'alias-title', 'alias-alias-label']) {
					await t.test(
						`restoration preserves existing ${collision} names beside an ${archived ? 'archived' : 'active'} owner`,
						async () => {
							const { doc, other } = await seed();
							if (collision === 'alias-title')
								await sql`UPDATE documents SET title='장비, 이전 이름' WHERE id=${other.id}`;
							else
								await sql`INSERT INTO redirects (alias_slug,alias_title,document_id)
									VALUES ('other-legacy-alias',${collision === 'title-alias-label' ? doc.title : '장비, 이전 이름'},${other.id})`;
							if (archived) await move(other.id, true);
							const before = await snapshot();
							assert.equal((await move(doc.id, true)).status, 'trashed');
							assert.equal(
								(await post(trash.actions.restore, await restoredFields(doc.id))).status,
								303
							);
							const after = await snapshot();
							preservedExceptLifecycle(after, before, doc.id);
							assert.equal(
								after.documents.find((d) => String(d.id) === String(doc.id)).lifecycle_version,
								2
							);
							assert.equal(String((await wiki.getDocument(alias)).document.id), String(doc.id));
						}
					);
				}
				for (const ownerRoute of ['canonical', 'alias']) {
					await t.test(
						`restoration does not claim an unused title URL owned by an ${archived ? 'archived' : 'active'} ${ownerRoute}`,
						async () => {
							const { doc, other, draft } = await seed();
							const originalSlug = 'legacy-original';
							await sql`UPDATE documents SET slug=${originalSlug} WHERE id=${doc.id}`;
							await sql`UPDATE drafts SET governance=jsonb_set(governance,'{published,slug}',to_jsonb(${originalSlug}::text)) WHERE id=${draft.id}`;
							if (ownerRoute === 'canonical')
								await sql`UPDATE documents SET slug=${slug} WHERE id=${other.id}`;
							else
								await sql`INSERT INTO redirects (alias_slug,alias_title,document_id)
									VALUES (${slug},'별도 문서의 옛 주소',${other.id})`;
							if (archived) await move(other.id, true);
							const ownerBefore = await wiki.getDocument(slug);
							assert.equal(ownerBefore?.document.id ?? null, archived ? null : other.id);
							const before = await snapshot();
							assert.equal((await move(doc.id, true)).status, 'trashed');
							const reviewed = await restoredFields(doc.id);
							const result = await post(trash.actions.restore, reviewed);
							assert.equal(result.status, 303);
							assert.equal(result.location, '/wiki/' + originalSlug);
							const after = await snapshot();
							preservedExceptLifecycle(after, before, doc.id);
							assert.equal(
								String((await wiki.getDocument(originalSlug)).document.id),
								String(doc.id)
							);
							assert.equal(String((await wiki.getDocument(alias)).document.id), String(doc.id));
							assert.deepEqual(await wiki.getDocument(slug), ownerBefore);
							assert.equal((await post(trash.actions.restore, reviewed)).status, 409);
							assert.deepEqual(await snapshot(), after);
						}
					);
				}
			}
			for (const collision of ['canonical-as-alias', 'alias-as-canonical'])
				await t.test(
					`restoration ${collision} conflicts preserve all archived rows until the actual address conflict is resolved`,
					async () => {
						const { doc, other } = await seed();
						await move(doc.id, true);
						const reviewed = await restoredFields(doc.id);
						if (collision === 'canonical-as-alias')
							await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${slug},'기존 주소 충돌',${other.id})`;
						else await sql`UPDATE documents SET slug=${alias} WHERE id=${other.id}`;
						const before = await snapshot(),
							result = await post(trash.actions.restore, reviewed);
						assert.equal(result.status, 409);
						assert.match(result.data.message, /사용하고 있어/);
						assert.equal(await wiki.getDocument(slug), null);
						assert.equal(await writer.getEditableDocument(slug), null);
						assert.equal((await reader.load({ params: { slug } })).trashed, true);
						assert.deepEqual(await snapshot(), before);
						await sql`DELETE FROM redirects WHERE document_id=${other.id}`;
						await sql`UPDATE documents SET slug=${other.slug} WHERE id=${other.id}`;
						assert.equal((await post(trash.actions.restore, reviewed)).status, 303);
					}
				);
			await t.test(
				'changed archived aliases and an archive/restore round trip invalidate the old restoration review',
				async () => {
					const { doc } = await seed();
					await move(doc.id, true);
					const input = await restoredFields(doc.id);
					await sql`UPDATE redirects SET alias_title='변경된 보관 별칭' WHERE document_id=${doc.id}`;
					const changed = await snapshot();
					assert.equal((await post(trash.actions.restore, input)).status, 409);
					assert.deepEqual(await snapshot(), changed);
					const current = await restoredFields(doc.id);
					assert.equal((await post(trash.actions.restore, current)).status, 303);
					await move(doc.id, true);
					const repeated = await snapshot();
					assert.equal((await post(trash.actions.restore, current)).status, 409);
					assert.deepEqual(await snapshot(), repeated);
				}
			);
			await t.test(
				'adjacent BIGINT document IDs select and restore the reviewed archive only',
				async () => {
					await seed();
					await sql`INSERT INTO documents(id,slug,title,content,deleted_at,deleted_by) VALUES(9007199254740992,'big-one','큰 번호 하나','첫 보관 본문',NOW(),'Operator-A'),(9007199254740993,'big-two','큰 번호 둘','둘째 보관 본문',NOW(),'Operator-A')`;
					const data = await trash.load({
						url: new URL('http://localhost/trash?open=9007199254740993')
					});
					assert.equal(String(data.selected.document.id), '9007199254740993');
					assert.equal(data.selected.document.content, '둘째 보관 본문');
					assert.equal(
						(
							await post(trash.actions.restore, {
								documentId: '9007199254740993',
								version: data.selected.version
							})
						).status,
						303
					);
					assert.ok(
						(await sql`SELECT deleted_at FROM documents WHERE id=9007199254740992`)[0].deleted_at
					);
				}
			);

			for (const [deleted, mode] of [
				[true, 'raise'],
				[true, 'skip'],
				[false, 'raise'],
				[false, 'skip']
			])
				await t.test(
					`${deleted ? 'delete' : 'restore'} UPDATE ${mode} rolls back without changing relationships`,
					async () => {
						const { doc } = await seed();
						if (!deleted) await move(doc.id, true);
						const values = deleted ? await fields() : await restoredFields(doc.id),
							before = await snapshot();
						await sql.unsafe(
							`CREATE FUNCTION trash_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mode === 'raise' ? "RAISE EXCEPTION 'test-private-trash-error';" : 'RETURN NULL;'} END $$`
						);
						await sql`CREATE TRIGGER trash_failure BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION trash_failure()`;
						try {
							const result = await post(
								deleted ? edit.actions.delete : trash.actions.restore,
								values
							);
							assert.equal(result.status, 500);
							assert.doesNotMatch(result.data.message, /test-private|division|trigger/);
							assert.deepEqual(await snapshot(), before);
						} finally {
							await sql`DROP TRIGGER trash_failure ON documents`;
							await sql`DROP FUNCTION trash_failure()`;
						}
						assert.equal(
							(await post(deleted ? edit.actions.delete : trash.actions.restore, values)).status,
							303
						);
					}
				);
			for (const deleted of [true, false])
				await t.test(
					`simultaneous ${deleted ? 'delete' : 'restore'} requests apply one transition on independent backends`,
					async () => {
						const { doc } = await seed();
						if (!deleted) await move(doc.id, true);
						const values = deleted ? await fields() : await restoredFields(doc.id),
							action = deleted ? edit.actions.delete : trash.actions.restore,
							before = await snapshot();
						const results = await overlap([() => post(action, values), () => post(action, values)]);
						assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
						const after = await snapshot();
						preservedExceptLifecycle(after, before, doc.id);
						assert.equal(
							after.documents[0].lifecycle_version,
							before.documents[0].lifecycle_version + 1
						);
					}
				);
			await t.test(
				'concurrent edit and deletion cannot apply both from the same reviewed version',
				async () => {
					const { doc } = await seed(),
						input = await fields();
					const results = await overlap([
						() => post(edit.actions.delete, input),
						() =>
							post(edit.actions.save, { ...input, title: '원본 장비', aliases: '장비, 이전 이름' })
					]);
					assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
					const after = await snapshot();
					if (after.documents[0].deleted_at) {
						assert.equal(after.documents[0].content, doc.content);
						assert.equal(after.revisions.length, 1);
					} else {
						assert.equal(after.documents[0].content, input.content);
						assert.equal(after.revisions.length, 2);
					}
				}
			);
			for (const operation of ['edit', 'rollback', 'discussion', 'discussion-roundtrip'])
				await t.test(
					`${operation} cannot write after archival during its AI inspection`,
					async (st) => {
						const { doc, revision } = await seed(),
							input = await fields();
						const reviewed = await history.load({
							params: { slug },
							url: new URL('http://localhost/history')
						});
						state.env.OPENAI_API_KEY = 'test-only-key';
						let changed,
							calls = 0;
						st.mock.method(globalThis, 'fetch', async () => {
							calls++;
							await move(doc.id, true);
							if (operation === 'discussion-roundtrip') await move(doc.id, false);
							changed = await snapshot();
							return seedAIResponse({ passed: true, reasons: [] });
						});
						let result;
						if (operation === 'edit')
							result = await post(edit.actions.save, { ...input, title: '원본 장비' });
						else if (operation === 'rollback')
							result = await post(history.actions.rollback, {
								documentId: doc.id,
								version: reviewed.version,
								revision: revision.id,
								revisionVersion: reviewed.revisions[0].version
							});
						else
							result = await post(discussion.actions.default, {
								title: '새 토론',
								body: '새 의견',
								editor: 'Editor-01'
							});
						assert.equal(result.status, 409);
						assert.equal(calls, 1);
						assert.deepEqual(await snapshot(), changed);
					}
				);
			await t.test(
				'trash paging reaches older documents and malformed or restored selections cannot be restored',
				async () => {
					await seed();
					await sql`INSERT INTO documents(slug,title,content,deleted_at,deleted_by) SELECT 'archived-'||n,'보관 문서 '||n,'보관 본문',NOW(),'Operator-A' FROM generate_series(1,51)n`;
					const first = await trash.load({ url: new URL('http://localhost/trash') }),
						second = await trash.load({ url: new URL('http://localhost/trash?page=2') });
					assert.equal(first.documents.length, 50);
					assert.equal(second.documents.length, 1);
					assert.equal(first.pages, 2);
					assert.equal(second.page, 2);
					assert.notEqual(first.documents[0].id, second.documents[0].id);
					assert.equal(
						(await trash.load({ url: new URL('http://localhost/trash?open=1e0') })).selected,
						null
					);
					assert.equal(
						(await post(trash.actions.restore, { documentId: '1e0', version: '0'.repeat(64) }))
							.status,
						400
					);
					assert.equal(
						(await post(trash.actions.restore, { documentId: '999999', version: '0'.repeat(64) }))
							.status,
						409
					);
				}
			);
			await t.test(
				'trash load and restore database errors are safe and keep the archived document unchanged',
				async () => {
					const { doc } = await seed();
					await move(doc.id, true);
					const input = await restoredFields(doc.id),
						before = await snapshot();
					await sql`ALTER TABLE documents RENAME TO unavailable_documents`;
					try {
						const data = await trash.load({ url: new URL('http://localhost/trash') });
						assert.ok(data.databaseError);
						assert.equal(data.selected, null);
						const result = await post(trash.actions.restore, input);
						assert.equal(result.status, 500);
						assert.doesNotMatch(result.data.message, /unavailable_documents|SELECT|relation/);
					} finally {
						await sql`ALTER TABLE unavailable_documents RENAME TO documents`;
					}
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'demo seed preserves archived content, IDs and aliases reserved by a different document',
				async () => {
					const { doc } = await seed();
					await sql`UPDATE documents SET title='예시:장비 인계 절차',slug='예시:장비-인계-절차' WHERE id=${doc.id}`;
					await sql`UPDATE redirects SET alias_slug='예시:장비-인수인계' WHERE document_id=${doc.id}`;
					await move(doc.id, true);
					const before = await snapshot(),
						cli = await mkdtemp(join(tmpdir(), 'wiki-viki-trash-demo-'));
					try {
						await mkdir(join(cli, 'scripts'));
						await copyFile(
							new URL('../scripts/seed-demo.js', import.meta.url),
							join(cli, 'scripts/seed-demo.js')
						);
						await symlink(
							fileURLToPath(new URL('../node_modules', import.meta.url)),
							join(cli, 'node_modules')
						);
						await writeFile(join(cli, '.env'), '');
						const [{ schema }] = await sql`SELECT current_schema() AS schema`;
						const target = new URL(process.env.GOVERNANCE_TEST_DATABASE_URL);
						target.searchParams.set('options', '-c search_path=' + schema);
						const result = await promisify(execFile)(
							'bun',
							['run', '--env-file=./.env', 'scripts/seed-demo.js'],
							{
								cwd: cli,
								env: { PATH: process.env.PATH, DATABASE_URL: target.toString() },
								timeout: 10000
							}
						);
						assert.match(result.stdout, /휴지통 보존으로 건너뜀 1개/);
						const after = await snapshot();
						assert.deepEqual(
							after.documents.find((d) => String(d.id) === String(doc.id)),
							before.documents.find((d) => String(d.id) === String(doc.id))
						);
						for (const key of ['aliases', 'revisions', 'discussions'])
							assert.deepEqual(
								after[key].filter((r) => String(r.document_id) === String(doc.id)),
								before[key].filter((r) => String(r.document_id) === String(doc.id))
							);
						await sql`UPDATE documents SET title='별도 보관 문서',slug='archived-owner' WHERE id=${doc.id}`;
						const aliasBefore = await snapshot();
						const repeated = await promisify(execFile)(
							'bun',
							['run', '--env-file=./.env', 'scripts/seed-demo.js'],
							{
								cwd: cli,
								env: { PATH: process.env.PATH, DATABASE_URL: target.toString() },
								timeout: 10000
							}
						);
						assert.match(repeated.stdout, /휴지통 보존으로 건너뜀 1개/);
						const aliasAfter = await snapshot();
						assert.deepEqual(
							aliasAfter.documents.find((d) => String(d.id) === String(doc.id)),
							aliasBefore.documents.find((d) => String(d.id) === String(doc.id))
						);
						assert.deepEqual(
							aliasAfter.aliases.filter((r) => String(r.document_id) === String(doc.id)),
							aliasBefore.aliases.filter((r) => String(r.document_id) === String(doc.id))
						);
						assert.equal(
							(await sql`SELECT id FROM documents WHERE slug='예시:장비-인계-절차'`).length,
							0
						);
					} finally {
						await rm(cli, { recursive: true, force: true });
					}
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
