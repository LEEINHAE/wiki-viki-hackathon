import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { neon } from '@neondatabase/serverless';
import { seedAIResponse } from './fixtures/seed-source.js';
import { publishDraft } from '../src/lib/server/draft-publication.js';

const enabled = process.env.RUN_GOVERNANCE_DB_TESTS === '1';

test(
	'draft publication transactions with isolated PostgreSQL',
	{ skip: !enabled, timeout: 60000 },
	async (t) => {
		const lib = fileURLToPath(new URL('../src/lib', import.meta.url));
		const fixture = fileURLToPath(new URL('./fixtures/governance-database.js', import.meta.url));
		const server = await createServer({
			configFile: false,
			envDir: false,
			server: { middlewareMode: true, ws: false, watch: null },
			resolve: { alias: { $lib: lib } },
			plugins: [
				{
					name: 'publication-test-database',
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
			await state.setupDatabase({ maxConnections: 6 });
			const sql = state.db();
			const { actions, load } = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			async function reset() {
				await state.clearDatabase();
				state.env.OPENAI_API_KEY = '';
			}
			async function seed(changes = {}) {
				const draft = {
					title: '장비 점검',
					slug: '장비-점검',
					content: '점검 기록을 남깁니다.',
					aliases: ['점검 안내'],
					...changes
				};
				const [row] =
					await sql`INSERT INTO drafts (title,slug,content,aliases,editor_handle,governance)
				VALUES (${draft.title},${draft.slug},${draft.content},${JSON.stringify(draft.aliases)},'Editor-01','{"seed":{"source":"test"}}'::jsonb) RETURNING *`;
				return row;
			}
			async function fields(id) {
				const data = await load({ url: new URL(`http://localhost/drafts?open=${id}`) });
				assert.equal(String(data.selected.id), String(id));
				assert.match(data.selected.version, /^[a-f0-9]{64}$/);
				return { id: String(id), version: data.selected.version };
			}
			async function post(values) {
				const body = new FormData();
				for (const [key, value] of Object.entries(values)) body.set(key, String(value));
				try {
					return await actions.publish({
						request: new Request('http://localhost/drafts', { method: 'POST', body })
					});
				} catch (error) {
					if (error.status === 303) return { status: 303, location: error.location };
					throw error;
				}
			}
			async function snapshot() {
				const [row] = await sql`SELECT jsonb_build_object(
				'documents', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
				'revisions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
				'redirects', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
				'discussions', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d),
				'drafts', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)
			) AS data`;
				return row.data;
			}
			async function waitForPublicationLocks(count) {
				const deadline = Date.now() + 4000;
				while (Date.now() < deadline) {
					const rows =
						await sql`SELECT pid FROM pg_stat_activity WHERE application_name=current_setting('application_name')
					AND state='active' AND wait_event_type='Lock'
					AND (query LIKE 'LOCK TABLE documents, redirects%' OR query LIKE '%WITH alias_input AS%')`;
					if (new Set(rows.map((row) => row.pid)).size === count) return;
					await delay(20);
				}
				assert.fail('Expected distinct publication backends waiting on real PostgreSQL locks.');
			}
			async function overlap(
				values,
				hold = (tx) => tx`LOCK TABLE documents IN SHARE ROW EXCLUSIVE MODE`
			) {
				const ready = Promise.withResolvers();
				const release = Promise.withResolvers();
				const gate = sql.begin(async (tx) => {
					await hold(tx);
					ready.resolve();
					await release.promise;
				});
				gate.catch(ready.reject);
				const pending = [];
				try {
					await ready.promise;
					for (const value of values) {
						const request = post(value);
						request.catch(() => {});
						pending.push(request);
					}
					await waitForPublicationLocks(values.length);
				} finally {
					release.resolve();
					await gate;
				}
				return Promise.all(pending);
			}
			await t.test(
				'publishes all rows once, preserves seed metadata and rejects a retry',
				async () => {
					await reset();
					const draft = await seed({ aliases: ['점검 안내', '점검_안내', '장비 점검', ' '] });
					const input = await fields(draft.id);
					assert.equal((await post(input)).status, 303);
					const after = await snapshot();
					assert.equal(after.documents.length, 1);
					assert.equal(after.revisions.length, 1);
					assert.equal(after.redirects.length, 1);
					assert.equal(after.revisions[0].document_id, after.documents[0].id);
					assert.equal(after.redirects[0].document_id, after.documents[0].id);
					assert.equal(after.documents[0].content, draft.content);
					assert.equal(after.drafts[0].status, 'published');
					assert.equal(after.drafts[0].governance.semantic.skipped, true);
					assert.deepEqual(after.drafts[0].governance.seed, { source: 'test' });
					assert.equal(after.drafts[0].governance.published.version, input.version);
					assert.equal((await post(input)).status, 409);
					assert.deepEqual(await snapshot(), after);
				}
			);
			await t.test('BIGINT draft ids remain distinct in selection and publication', async () => {
				await reset();
				const a = await seed();
				const b = await seed({ title: '다른 초안', slug: '다른-초안' });
				await sql`UPDATE drafts SET id=9007199254740992 WHERE id=${a.id}`;
				await sql`UPDATE drafts SET id=9007199254740993 WHERE id=${b.id}`;
				assert.equal((await post(await fields('9007199254740993'))).status, 303);
				const rows = await sql`SELECT id,status FROM drafts ORDER BY id`;
				assert.deepEqual(
					rows.map((row) => [String(row.id), row.status]),
					[
						['9007199254740992', 'review'],
						['9007199254740993', 'published']
					]
				);
			});
			for (const kind of [
				'title',
				'slug',
				'route-alias',
				'alias-route',
				'alias-alias',
				'alias-title',
				'title-alias-label',
				'alias-alias-label'
			]) {
				await t.test(
					`existing ${kind} conflict leaves every existing row and the draft unchanged`,
					async () => {
						await reset();
						const draft = await seed();
						const [doc] = await sql`INSERT INTO documents (title,slug,content) VALUES
					(${kind === 'title' ? draft.title : kind === 'alias-title' ? '점검 안내' : '기존 문서'},${kind === 'slug' ? draft.slug : kind === 'alias-route' ? '점검-안내' : '기존-문서'},'기존 본문') RETURNING id`;
						await sql`INSERT INTO revisions (document_id,content,editor_handle) VALUES (${doc.id},'기존 이력','Editor-02')`;
						await sql`INSERT INTO discussions (document_id,thread_title,body,editor_handle) VALUES (${doc.id},'기존 토론','보존 의견','Editor-02')`;
						if (
							['route-alias', 'alias-alias', 'title-alias-label', 'alias-alias-label'].includes(
								kind
							)
						)
							await sql`INSERT INTO redirects (alias_slug,alias_title,document_id)
					VALUES (${kind === 'route-alias' ? draft.slug : kind === 'alias-alias' ? '점검-안내' : 'legacy-alias'},${kind === 'title-alias-label' ? draft.title : kind === 'alias-alias-label' ? '점검 안내' : '기존 별칭'},${doc.id})`;
						const before = await snapshot();
						assert.equal((await post(await fields(draft.id))).status, 409);
						assert.deepEqual(await snapshot(), before);
					}
				);
			}
			for (const table of ['drafts', 'documents', 'revisions', 'redirects']) {
				for (const behavior of ['raise', 'skip']) {
					await t.test(
						`${table} ${behavior} trigger rolls back the entire publication and permits retry`,
						async () => {
							await reset();
							const draft = await seed();
							const input = await fields(draft.id);
							const before = await snapshot();
							await sql.unsafe(
								`CREATE FUNCTION fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${behavior === 'raise' ? "RAISE EXCEPTION 'test-private-db-detail';" : 'RETURN NULL;'} END $$`
							);
							await sql.unsafe(
								`CREATE TRIGGER reject_publication BEFORE ${table === 'drafts' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_publication()`
							);
							try {
								const result = await post(input);
								assert.equal(result.status, table === 'drafts' && behavior === 'skip' ? 409 : 503);
								assert.doesNotMatch(
									JSON.stringify(result),
									/test-private|division by zero|postgres/i
								);
								assert.deepEqual(await snapshot(), before);
							} finally {
								await sql.unsafe(`DROP TRIGGER reject_publication ON ${table}`);
								await sql`DROP FUNCTION fail_publication()`;
							}
							assert.equal((await post(input)).status, 303);
							assert.equal((await snapshot()).revisions.length, 1);
						}
					);
				}
			}
			await t.test(
				'missing, malformed and stale review versions stop before external inspection',
				async (st) => {
					await reset();
					const draft = await seed();
					const input = await fields(draft.id);
					state.env.OPENAI_API_KEY = 'test-only-key';
					const fetch = st.mock.method(globalThis, 'fetch', () => {
						throw new Error('must not call');
					});
					const before = await snapshot();
					for (const version of ['', 'bad', 'a'.repeat(64)])
						assert.ok([400, 409].includes((await post({ ...input, version })).status));
					assert.deepEqual(await snapshot(), before);
					await sql`UPDATE drafts SET updated_at=updated_at+interval '1 microsecond' WHERE id=${draft.id}`;
					const changed = await snapshot();
					assert.equal((await post(input)).status, 409);
					assert.deepEqual(await snapshot(), changed);
					assert.equal(fetch.mock.callCount(), 0);
				}
			);
			for (const field of [
				'title',
				'slug',
				'content',
				'aliases',
				'source_name',
				'editor_handle',
				'governance',
				'deleted',
				'rejected-inspection'
			]) {
				await t.test(
					`${field} change during AI inspection cannot publish or block a different draft snapshot`,
					async (st) => {
						await reset();
						const draft = await seed();
						const input = await fields(draft.id);
						state.env.OPENAI_API_KEY = 'test-only-key';
						let changed;
						const fetch = st.mock.method(globalThis, 'fetch', async () => {
							if (field === 'deleted') await sql`DELETE FROM drafts WHERE id=${draft.id}`;
							else if (field === 'aliases')
								await sql`UPDATE drafts SET aliases='["다른 별칭"]'::jsonb WHERE id=${draft.id}`;
							else if (field === 'governance')
								await sql`UPDATE drafts SET governance='{"seed":{"source":"changed"}}'::jsonb WHERE id=${draft.id}`;
							else if (field === 'editor_handle')
								await sql`UPDATE drafts SET editor_handle='Editor-77' WHERE id=${draft.id}`;
							else
								await sql.unsafe(
									`UPDATE drafts SET ${field === 'rejected-inspection' ? 'content' : field}=$1 WHERE id=$2`,
									['수정된-값', draft.id]
								);
							changed = await snapshot();
							return seedAIResponse({
								passed: field !== 'rejected-inspection',
								reasons: field === 'rejected-inspection' ? ['검토 필요'] : []
							});
						});
						assert.equal((await post(input)).status, 409);
						assert.deepEqual(await snapshot(), changed);
						assert.equal(fetch.mock.callCount(), 1);
					}
				);
			}
			await t.test(
				'same draft submitted concurrently uses distinct backends and publishes once',
				async () => {
					await reset();
					const draft = await seed();
					const input = await fields(draft.id);
					assert.deepEqual((await overlap([input, input])).map((r) => r.status).sort(), [303, 409]);
					const after = await snapshot();
					assert.equal(after.documents.length, 1);
					assert.equal(after.revisions.length, 1);
					assert.equal(after.redirects.length, 1);
				}
			);
			for (const kind of ['same-title', 'same-alias', 'route-versus-alias']) {
				await t.test(
					`concurrent distinct drafts with ${kind} have exactly one winner`,
					async () => {
						await reset();
						const a = await seed();
						const b = await seed(
							kind === 'same-title'
								? { aliases: [] }
								: {
										title: '다른 점검',
										slug: kind === 'route-versus-alias' ? '점검-안내' : '다른-점검',
										aliases: kind === 'same-alias' ? ['점검 안내'] : []
									}
						);
						assert.deepEqual(
							(await overlap([await fields(a.id), await fields(b.id)])).map((r) => r.status).sort(),
							[303, 409]
						);
						const after = await snapshot();
						assert.equal(after.documents.length, 1);
						assert.equal(after.revisions.length, 1);
						assert.deepEqual(after.drafts.map((d) => d.status).sort(), ['published', 'review']);
					}
				);
			}
			await t.test('an in-flight draft edit is rechecked after its row lock releases', async () => {
				await reset();
				const draft = await seed();
				const [result] = await overlap(
					[await fields(draft.id)],
					(tx) => tx`UPDATE drafts SET content='동시 수정 본문' WHERE id=${draft.id}`
				);
				assert.equal(result.status, 409);
				const after = await snapshot();
				assert.equal(after.documents, null);
				assert.equal(after.drafts[0].content, '동시 수정 본문');
				assert.equal(after.drafts[0].status, 'review');
			});
			await t.test(
				'an in-flight alias writer is visible after the publication table lock releases',
				async () => {
					await reset();
					const draft = await seed();
					const [doc] =
						await sql`INSERT INTO documents (title,slug) VALUES ('기존 대상','existing') RETURNING id`;
					const [result] = await overlap(
						[await fields(draft.id)],
						(tx) =>
							tx`INSERT INTO redirects (alias_slug,alias_title,document_id) VALUES ('점검-안내','점검 안내',${doc.id})`
					);
					assert.equal(result.status, 409);
					const after = await snapshot();
					assert.equal(after.documents.length, 1);
					assert.equal(after.redirects[0].document_id, Number(doc.id));
					assert.equal(after.drafts[0].status, 'review');
				}
			);
			await t.test(
				'actual Neon transaction serialization executes the same atomic SQL on local PostgreSQL',
				async (st) => {
					await reset();
					const seeded = await seed();
					const [draft] =
						await sql`SELECT d.*, (to_jsonb(d)-'id')::text AS snapshot FROM drafts d WHERE id=${seeded.id}`;
					const fetch = st.mock.method(globalThis, 'fetch', async (_url, options) => {
						const batch = JSON.parse(options.body);
						assert.equal(batch.queries.length, 3);
						assert.match(batch.queries[1].query, /LOCK TABLE documents, redirects/);
						assert.equal(
							new Headers(options.headers).get('Neon-Batch-Isolation-Level'),
							'ReadCommitted'
						);
						const results = await sql.begin(async (tx) => {
							const outputs = [];
							for (const query of batch.queries) {
								const rows = await tx.unsafe(query.query, query.params);
								outputs.push({
									fields: (rows.columns || []).map((c) => ({ name: c.name, dataTypeID: c.type })),
									rows: rows.map((r) =>
										rows.columns.map((c) => (r[c.name] === null ? null : String(r[c.name])))
									),
									rowCount: rows.count,
									command: rows.command
								});
							}
							return outputs;
						});
						return Response.json({ results });
					});
					const client = neon('postgresql://test:test@database.invalid/test');
					const result = await publishDraft(
						client,
						draft,
						{ passed: true, semantic: { skipped: true } },
						[{ alias_slug: '점검-안내', alias_title: '점검 안내' }]
					);
					assert.equal(result.status, 'published');
					assert.equal(fetch.mock.callCount(), 1);
					assert.equal((await snapshot()).revisions.length, 1);
				}
			);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
