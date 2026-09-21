import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { mapDocuments, mapAliases } from './fixtures/knowledge-map.js';

test(
	'map exploration reads current PostgreSQL connections without changing stored data',
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
					name: 'map-db',
					enforce: 'pre',
					resolveId(id) {
						if (id === '$env/dynamic/private' || id === `${lib}/server/db.js` || id === './db.js')
							return fixture;
					}
				}
			]
		});
		const state = await server.ssrLoadModule(fixture);
		let externalCalls = 0;
		t.mock.method(globalThis, 'fetch', async () => {
			externalCalls++;
			throw new Error('External calls disabled');
		});
		try {
			await state.setupDatabase();
			const sql = state.db();
			const { load } = await server.ssrLoadModule('/src/routes/+page.server.js');
			const read = (query = '') => load({ url: new URL('http://localhost/?view=map' + query) });
			for (const d of mapDocuments)
				await sql`INSERT INTO documents(id,slug,title,content) VALUES(${d.id},${d.slug},${d.title},${d.content})`;
			for (const a of mapAliases)
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES(${a.alias_slug},${a.alias_title},${a.document_id})`;
			await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(1,'원래 이력','Editor-01')`;
			await sql`INSERT INTO drafts(title,slug,content) VALUES('보존 초안','draft','보존 본문')`;
			const snapshot = async () =>
				(
					await sql`SELECT jsonb_build_object(
			'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),
			'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),
			'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),
			'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
				)[0].data;
			await t.test(
				'URL-selected centers, aliases, all neighbors and isolated documents preserve data and totals',
				async () => {
					const before = await snapshot();
					const initial = await read();
					assert.equal(initial.graph.nodes[0].slug, 'root');
					assert.equal(initial.graph.neighborCount, 8);
					for (const [query, slug, count] of [
						['&center=branch', 'branch', 2],
						['&center=old-name', 'deep', 2],
						['&center=standalone', 'standalone', 0],
						['&center=root&mapPage=2', 'root', 8]
					]) {
						const data = await read(query);
						assert.equal(data.databaseReady, true);
						assert.equal(data.graph.nodes[0].slug, slug);
						assert.equal(data.graph.neighborCount, count);
						assert.deepEqual(data.stats, initial.stats);
						assert.equal(data.graph.documents.length, mapDocuments.length);
						assert.ok(
							data.graph.documents.every((d) => Object.keys(d).sort().join(',') === 'slug,title')
						);
					}
					assert.equal((await read('&center=root&mapPage=2')).graph.nodes.length, 3);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'a subsequent read reflects edited, trashed and restored connections',
				async () => {
					await sql`UPDATE documents SET deleted_at=now(),deleted_by='Editor-01' WHERE slug='deep'`;
					let before = await snapshot();
					let data = await read('&center=old-name');
					assert.equal(data.graph.centerUnavailable, true);
					assert.equal(
						data.graph.documents.some((d) => d.slug === 'deep'),
						false
					);
					assert.deepEqual(await snapshot(), before);
					await sql`UPDATE documents SET deleted_at=NULL,deleted_by=NULL WHERE slug='deep'`;
					await sql`UPDATE documents SET content='[[standalone]]' WHERE slug='deep'`;
					before = await snapshot();
					data = await read('&center=old-name');
					assert.equal(data.graph.nodes[0].slug, 'deep');
					assert.deepEqual(
						new Set(data.graph.nodes.slice(1).map((d) => d.slug)),
						new Set(['branch', 'standalone'])
					);
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'lookup errors stay distinct from an empty map and retry keeps the requested center',
				async () => {
					await sql`ALTER TABLE documents RENAME TO map_unavailable`;
					try {
						const data = await read('&center=branch');
						assert.equal(data.databaseReady, false);
						assert.equal(data.view, 'map');
						assert.equal(data.stats, null);
					} finally {
						await sql`ALTER TABLE map_unavailable RENAME TO documents`;
					}
					assert.equal((await read('&center=branch')).graph.nodes[0].slug, 'branch');
					await state.clearDatabase();
					const empty = await read();
					assert.equal(empty.databaseReady, true);
					assert.deepEqual(empty.graph.nodes, []);
					assert.equal(empty.graph.neighborCount, 0);
				}
			);
			assert.equal(externalCalls, 0);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
