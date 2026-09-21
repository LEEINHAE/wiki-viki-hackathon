import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test(
	'automatic document connections use current isolated PostgreSQL without rewriting user data',
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
					name: 'isolated-auto-links',
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
			await state.setupDatabase({ maxConnections: 4 });
			state.env.OPENAI_API_KEY = '';
			const sql = state.db();
			const reader = await server.ssrLoadModule('/src/routes/wiki/[slug]/+page.server.js');
			const home = await server.ssrLoadModule('/src/routes/+page.server.js');
			const links = await server.ssrLoadModule('/src/routes/links/+page.server.js');
			const drafts = await server.ssrLoadModule('/src/routes/drafts/+page.server.js');
			const { POST: preview } = await server.ssrLoadModule('/src/routes/api/preview/+server.js');
			const { getEditableDocument, saveDocument } = await server.ssrLoadModule(
				'/src/lib/server/document-write.js'
			);
			const { changeDocumentTrash } = await server.ssrLoadModule(
				'/src/lib/server/document-trash.js'
			);
			const inspect = (page = '') => links.load({ url: new URL('http://local/links' + page) });
			const read = (slug) => reader.load({ params: { slug } });
			const snapshot = async () =>
				(
					await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM revisions r),'redirects',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM redirects r),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d)) data`
				)[0].data;
			const [source] =
				await sql`INSERT INTO documents(title,slug,content) VALUES('교대 인계','handover','RFCC와 설비 점검을 확인한다. 신규 장비는 추후 연결한다. [[미작성 문서|표시 이름]]') RETURNING *`;
			const [target] =
				await sql`INSERT INTO documents(id,title,slug,content) VALUES(9007199254740993,'RFCC','rfcc','교대 인계에 기록한다.') RETURNING *`;
			const [equipment] =
				await sql`INSERT INTO documents(title,slug,content) VALUES('정기 점검','fixed-inspection','점검 안내') RETURNING *`;
			await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('old-inspection','설비 점검',${equipment.id})`;
			await sql`INSERT INTO revisions(document_id,content,editor_handle,summary) VALUES(${source.id},${source.content},'Editor-01','원래 이력')`;
			await sql`INSERT INTO drafts(title,slug,content,governance) VALUES('검토 문서','draft','RFCC와 신규 장비를 검토한다.','{"passed":true}')`;
			const original = await snapshot();
			const version = (await getEditableDocument('handover')).version;
			await t.test(
				'reader, backlinks, home graph, preview and full inspection agree with no writes or AI',
				async () => {
					for (let i = 0; i < 2; i++) {
						const page = await read('handover');
						assert.match(page.html, /href="\/wiki\/rfcc"[^>]*data-auto-link="true"/);
						assert.match(page.html, /href="\/wiki\/fixed-inspection"[^>]*>설비 점검<\/a>/);
						assert.deepEqual(page.related.map((doc) => doc.slug).sort(), [
							'fixed-inspection',
							'rfcc'
						]);
						assert.deepEqual(
							(await read('rfcc')).backlinks.map((doc) => doc.slug),
							['handover']
						);
						const report = (await inspect()).report;
						assert.equal(report.documents, 3);
						assert.equal(report.automatic, 3);
						assert.equal(report.total, 3);
						assert.equal(report.unresolved, 1);
						const dashboard = await home.load({ url: new URL('http://local/?view=map') });
						assert.equal(dashboard.stats.links, report.total);
						const response = await preview({
							request: new Request('http://local/api/preview', {
								method: 'POST',
								body: JSON.stringify({ content: '설비 점검과 RFCC를 확인한다.' })
							})
						});
						assert.equal(response.status, 200);
						assert.match((await response.json()).html, /data-auto-link="true"/);
						assert.match(
							(await drafts.load({ url: new URL('http://local/drafts') })).reviewList.items[0]
								.previewHtml,
							/data-auto-link="true"/
						);
					}
					assert.deepEqual(await snapshot(), original);
					assert.equal((await getEditableDocument('handover')).version, version);
				}
			);
			await t.test(
				'a newly saved target retroactively connects old prose without another approval or source revision',
				async () => {
					assert.equal(
						(
							await saveDocument({
								title: '신규 장비',
								requestedSlug: '신규-장비',
								content: '교대 인계로 연결한다.',
								editor: 'Editor-01',
								expected: null,
								aliases: []
							})
						).status,
						'saved'
					);
					assert.match((await read('handover')).html, /data-auto-link="true"[^>]*>신규 장비<\/a>/);
					assert.deepEqual(
						(await read('신규-장비')).backlinks.map((doc) => doc.slug),
						['handover']
					);
					assert.equal((await getEditableDocument('handover')).version, version);
					assert.equal(
						(await sql`SELECT count(*)::int n FROM revisions WHERE document_id=${source.id}`)[0].n,
						1
					);
				}
			);
			await t.test(
				'alias removal, trash and recovery recalculate links without deleting manual source or existing history',
				async () => {
					const expected = await getEditableDocument('fixed-inspection');
					assert.equal(
						(
							await saveDocument({
								title: equipment.title,
								requestedSlug: equipment.slug,
								content: equipment.content,
								editor: 'Editor-01',
								expected,
								aliases: []
							})
						).status,
						'saved'
					);
					assert.doesNotMatch((await read('handover')).html, /href="\/wiki\/fixed-inspection"/);
					await changeDocumentTrash({ expected: await getEditableDocument('rfcc'), deleted: true });
					assert.doesNotMatch((await read('handover')).html, /href="\/wiki\/rfcc"/);
					assert.equal((await inspect()).report.documents, 3);
					await changeDocumentTrash({
						expected: await getEditableDocument('', target.id, { includeDeleted: true }),
						deleted: false
					});
					assert.match((await read('handover')).html, /href="\/wiki\/rfcc"/);
					assert.equal((await getEditableDocument('handover')).version, version);
					assert.equal(
						(await sql`SELECT content FROM documents WHERE id=${source.id}`)[0].content,
						source.content
					);
				}
			);
			await t.test(
				'repeated and concurrent inspections cannot invalidate an in-progress edit',
				async () => {
					const expected = await getEditableDocument('handover');
					const [saved, ...reports] = await Promise.all([
						saveDocument({
							title: source.title,
							requestedSlug: source.slug,
							content: source.content + '\n검토자가 추가한 설명.',
							editor: 'Editor-01',
							expected,
							aliases: []
						}),
						inspect(),
						inspect(),
						inspect()
					]);
					assert.equal(saved.status, 'saved');
					assert.ok(reports.every((result) => !result.databaseError));
					assert.match(
						(await getEditableDocument('handover')).document.content,
						/검토자가 추가한 설명/
					);
					assert.equal(
						(await sql`SELECT count(*)::int n FROM revisions WHERE document_id=${source.id}`)[0].n,
						2
					);
				}
			);
			await t.test('legacy aliases cannot reuse a URL reserved by a trashed document', async () => {
				await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('보관 주소','보관-주소','보존할 본문',NOW(),'Editor-01')`;
				await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('보관-주소','보관 주소',${equipment.id})`;
				await sql`INSERT INTO documents(title,slug,content) VALUES('연결 경계','route-boundary','[[보관 주소]]\n\n보관 주소를 확인합니다.')`;
				const page = await read('route-boundary');
				assert.match(page.html, /wiki-link missing/);
				assert.doesNotMatch(page.html, /data-auto-link/);
				assert.equal(page.related.length, 0);
				assert.equal((await read('보관-주소')).trashed, true);
				const row = (await inspect()).report.rows.find((row) => row.slug === 'route-boundary');
				assert.equal(row.connections.length, 0);
				assert.deepEqual(row.missing, [{ slug: '보관-주소', title: '보관 주소' }]);
			});
			await t.test(
				'empty state, full counts with paginated rows, and real database failure are distinct',
				async () => {
					await state.clearDatabase();
					assert.equal((await inspect()).report.documents, 0);
					await sql`INSERT INTO documents(title,slug,content) SELECT '검사 문서 '||n,'doc-'||n,'' FROM generate_series(1,23) n`;
					const first = (await inspect()).report,
						last = (await inspect('?page=999')).report;
					assert.equal(first.documents, 23);
					assert.equal(first.rows.length, 20);
					assert.equal(last.page, 2);
					assert.equal(last.rows.length, 3);
					assert.equal(last.isolated, 23);
					await sql`ALTER TABLE redirects RENAME TO link_test_unavailable_aliases`;
					try {
						assert.deepEqual(await inspect(), { report: null, databaseError: true });
					} finally {
						await sql`ALTER TABLE link_test_unavailable_aliases RENAME TO redirects`;
					}
				}
			);
			assert.equal(externalCalls, 0);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
