import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import postgres from 'postgres';
import { repairTrashSchema } from '../scripts/lib/trash-schema.js';

test(
	'trash actions through the actual Neon serializer preserve and restore local PostgreSQL data',
	{ skip: process.env.RUN_GOVERNANCE_DB_TESTS !== '1' },
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
					name: 'neon-trash-transport',
					enforce: 'pre',
					resolveId(id) {
						if (id === '$env/dynamic/private') return fixture;
						if (id === `${lib}/server/db.js` || id === './db.js') return '\0neon-local-db';
					},
					load(id) {
						if (id === '\0neon-local-db')
							return `import { neon } from '@neondatabase/serverless'; export const db = () => neon('postgresql://test:test@database.invalid/test');`;
					}
				}
			]
		});
		const state = await server.ssrLoadModule(fixture);
		let transport;
		try {
			await state.setupDatabase();
			const sql = state.db();
			const [{ schema }] = await sql`SELECT current_schema() AS schema`;
			// Neon already serialized every parameter. Preserve those wire strings,
			// including false and text arrays, and return raw PostgreSQL field bytes.
			transport = postgres(process.env.GOVERNANCE_TEST_DATABASE_URL, {
				max: 1,
				connection: { search_path: schema },
				types: Object.fromEntries(
					[16, 114, 3802, 1009].map((oid) => [
						'raw' + oid,
						{ to: oid, from: [oid], serialize: (v) => v, parse: (v) => v }
					])
				),
				onnotice: () => {}
			});
			let requests = 0;
			t.mock.method(globalThis, 'fetch', async (_url, options) => {
				requests++;
				const body = JSON.parse(options.body);
				const run = async (tx, query) => {
					const rows = await tx.unsafe(query.query, query.params).raw();
					const columns = rows.columns || [];
					return {
						fields: columns.map((c) => ({ name: c.name, dataTypeID: c.type })),
						rows: rows.map((r) => r.map((v) => (v === null ? null : v.toString('utf8')))),
						rowCount: rows.count,
						command: rows.command
					};
				};
				try {
					if (!body.queries) return Response.json(await run(transport, body));
					assert.equal(
						new Headers(options.headers).get('Neon-Batch-Isolation-Level'),
						'ReadCommitted'
					);
					const results = await transport.begin(async (tx) => {
						const results = [];
						for (const q of body.queries) results.push(await run(tx, q));
						return results;
					});
					return Response.json({ results });
				} catch (e) {
					return Response.json({ message: e.message, code: e.code }, { status: 400 });
				}
			});
			const edit = await server.ssrLoadModule('/src/routes/edit/[slug]/+page.server.js');
			const trash = await server.ssrLoadModule('/src/routes/trash/+page.server.js');
			const [doc] =
				await sql`INSERT INTO documents(title,slug,content) VALUES('드라이버 검증','transport','보관할 본문') RETURNING *`;
			await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('transport-alias','기존 별칭',${doc.id})`;
			const loaded = await edit.load({ params: { slug: 'transport' } });
			assert.equal(loaded.document?.title, doc.title);
			const invoke = async (action, values) => {
				const body = new FormData();
				for (const [key, value] of Object.entries(values)) body.set(key, String(value));
				try {
					return await action({
						params: { slug: 'transport' },
						request: new Request('http://localhost/action', { method: 'POST', body })
					});
				} catch (e) {
					if (e.status === 303) return { status: e.status, location: e.location };
					throw e;
				}
			};
			const removed = await invoke(edit.actions.delete, {
				documentId: loaded.document.id,
				version: loaded.version,
				confirmDelete: 'yes',
				editor: 'Editor-01'
			});
			assert.equal(removed.status, 303, JSON.stringify(removed));
			assert.equal(removed.location, '/trash?open=' + doc.id);
			const archived = await trash.load({ url: new URL('http://localhost/trash?open=' + doc.id) });
			assert.equal(archived.selected?.document.content, doc.content, JSON.stringify(archived));
			const restored = await invoke(trash.actions.restore, {
				documentId: doc.id,
				version: archived.selected.version
			});
			assert.equal(restored.status, 303, JSON.stringify(restored));
			assert.equal(restored.location, '/wiki/transport');
			assert.equal(
				(await sql`SELECT deleted_at FROM documents WHERE id=${doc.id}`)[0].deleted_at,
				null
			);
			assert.ok(requests > 0);

			await t.test(
				'legacy schema repair preserves rows, relationships and migration history',
				async () => {
					await sql`ALTER TABLE documents DROP COLUMN lifecycle_version`;
					await sql`ALTER TABLE documents ADD COLUMN legacy_metadata JSONB DEFAULT '{}'::jsonb`;
					await sql`UPDATE documents SET legacy_metadata='{"preserved":true}'`;
					// The affected installation uses an older name/checksum-only ledger.
					await sql`ALTER TABLE schema_migrations DROP COLUMN version`;
					await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES (${doc.id},'원래 이력','Editor-01')`;
					await sql`INSERT INTO discussions(document_id,thread_title,body,editor_handle) VALUES (${doc.id},'원래 토론','의견','Editor-01')`;
					await sql`INSERT INTO drafts(title,slug,content,status,governance) VALUES ('게시 초안','published-draft','기존 초안','published','{"published":{"slug":"transport"}}')`;
					const [previous] =
						await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by)
					VALUES ('이전에 보관한 문서','already-trashed','보관 본문','2026-09-20 12:34:56.123456+00','Editor-02') RETURNING id`;
					const snapshot = async () =>
						(
							await sql`SELECT jsonb_build_object(
					'documents',(SELECT jsonb_agg(to_jsonb(d)-'lifecycle_version' ORDER BY id) FROM documents d),
					'aliases',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
					'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
					'discussions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM discussions r),
					'drafts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM drafts r),
					'migrations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY name) FROM schema_migrations r)
				) AS data`
						)[0].data;
					const before = await snapshot();
					const fields = {
						documentId: doc.id,
						version: (await edit.load({ params: { slug: 'transport' } })).version,
						confirmDelete: 'yes',
						editor: 'Editor-01',
						title: '작성 중 제목',
						content: '작성 중 본문',
						aliases: '기존 별칭',
						summary: '작성 중 요약'
					};
					const failed = await invoke(edit.actions.delete, fields);
					assert.equal(failed.status, 503, JSON.stringify(failed));
					assert.match(failed.data.message, /업데이트/);
					assert.equal(failed.data.content, fields.content);
					const previousReview = await trash.load({
						url: new URL('http://localhost/trash?open=' + previous.id)
					});
					const failedRestore = await invoke(trash.actions.restore, {
						documentId: previous.id,
						version: previousReview.selected.version
					});
					assert.equal(failedRestore.status, 503);
					assert.deepEqual(await snapshot(), before);
					assert.deepEqual(await repairTrashSchema({ sql }), {
						status: 'missing-lifecycle-version'
					});
					assert.deepEqual(await snapshot(), before);
					assert.deepEqual(await repairTrashSchema({ sql, apply: true }), { status: 'repaired' });
					assert.deepEqual(await snapshot(), before);
					assert.deepEqual(await repairTrashSchema({ sql, apply: true }), { status: 'ready' });
					assert.deepEqual(await snapshot(), before);
					assert.equal((await invoke(edit.actions.delete, fields)).status, 409);
					fields.version = (await edit.load({ params: { slug: 'transport' } })).version;
					assert.equal((await invoke(edit.actions.delete, fields)).status, 303);
					assert.equal((await invoke(edit.actions.delete, fields)).status, 409);
					const reviewed = await trash.load({
						url: new URL('http://localhost/trash?open=' + doc.id)
					});
					assert.equal(reviewed.selected.document.content, doc.content);
					assert.equal(
						(
							await invoke(trash.actions.restore, {
								documentId: doc.id,
								version: reviewed.selected.version
							})
						).status,
						303
					);
					assert.equal((await invoke(edit.actions.delete, fields)).status, 409);
					assert.equal(
						(await sql`SELECT lifecycle_version FROM documents WHERE id=${doc.id}`)[0]
							.lifecycle_version,
						'2'
					);
					assert.deepEqual(await snapshot(), before);
				}
			);
		} finally {
			await transport?.end();
			await state.closeDatabase();
			await server.close();
		}
	}
);
