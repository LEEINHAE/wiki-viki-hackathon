import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
	seedReadingConnections,
	connectionSource,
	longConnectionLabel
} from './fixtures/reading-connections.js';

test(
	'reader connection reasons match real content, aliases and lifecycle without writes',
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
					name: 'isolated-reader-connections',
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
			const { getEditableDocument, saveDocument } = await server.ssrLoadModule(
				'/src/lib/server/document-write.js'
			);
			const { changeDocumentTrash } = await server.ssrLoadModule(
				'/src/lib/server/document-trash.js'
			);
			const { readLinkSnapshot } = await server.ssrLoadModule('/src/lib/server/document-links.js');
			const read = (slug = 'reading-connections') => reader.load({ params: { slug } });
			const snapshot = async () =>
				(
					await sql`SELECT jsonb_build_object('documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d),'revisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM revisions d),'redirects',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM redirects d),'drafts',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM drafts d),'discussions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM discussions d)) data`
				)[0].data;
			const docs = await seedReadingConnections(sql);
			const originalVersion = (await getEditableDocument('reading-connections')).version;
			await t.test(
				'canonical reader and alias entry preserve both directions, actual labels, order and all stored data',
				async () => {
					const before = await snapshot();
					for (const slug of ['reading-connections', 'old-handover']) {
						const page = await read(slug);
						assert.deepEqual(page.related.find((d) => d.slug === 'fixed-rfcc').connection, {
							automatic: true,
							label: '공정 별칭'
						});
						assert.deepEqual(page.related.find((d) => d.slug === 'guide').connection, {
							automatic: false,
							label: '저장된 안내'
						});
						assert.deepEqual(page.related.find((d) => d.slug === 'long-target').connection, {
							automatic: false,
							label: longConnectionLabel
						});
						assert.equal(page.related.length, 3);
						assert.deepEqual(page.backlinks.find((d) => d.slug === 'incoming-auto').connection, {
							automatic: true,
							label: '기록 별칭'
						});
						assert.deepEqual(page.backlinks.find((d) => d.slug === 'incoming-manual').connection, {
							automatic: false,
							label: '저장된 교대 링크'
						});
						assert.equal(page.backlinks.length, 2);
						const order = (await readLinkSnapshot({ content: true })).documents.map((d) => d.slug);
						assert.deepEqual(
							page.related.map((d) => d.slug),
							order.filter((slug) => ['fixed-rfcc', 'guide', 'long-target'].includes(slug))
						);
						assert.match(page.html, /href="\/wiki\/fixed-rfcc"[^>]*data-auto-link/);
						assert.equal(page.document.content, connectionSource);
					}
					assert.deepEqual(await snapshot(), before);
					assert.equal((await getEditableDocument('reading-connections')).version, originalVersion);
				}
			);
			await t.test(
				'removing an alias updates only real connections; a new explicit source link takes precedence after save',
				async () => {
					const target = docs.automatic;
					assert.equal(
						(
							await saveDocument({
								title: target.title,
								requestedSlug: target.slug,
								content: target.content,
								editor: 'Editor-01',
								expected: await getEditableDocument(target.slug),
								aliases: []
							})
						).status,
						'saved'
					);
					assert.equal(
						(await read()).related.some((d) => d.slug === target.slug),
						false
					);
					const content = connectionSource + '\n\n[[fixed-rfcc|명시적으로 저장한 링크]]';
					const current = await getEditableDocument('reading-connections');
					assert.equal(
						(
							await saveDocument({
								title: docs.source.title,
								requestedSlug: docs.source.slug,
								content,
								editor: 'Editor-01',
								expected: current,
								aliases: current.aliases
							})
						).status,
						'saved'
					);
					const before = await snapshot();
					assert.deepEqual((await read()).related.find((d) => d.slug === target.slug).connection, {
						automatic: false,
						label: '명시적으로 저장한 링크'
					});
					assert.deepEqual(await snapshot(), before);
				}
			);
			await t.test(
				'actual trash and restoration remove and recover outgoing and incoming reasons without source edits',
				async () => {
					const version = (await getEditableDocument('reading-connections')).version;
					for (const [target, direction] of [
						[docs.manual, 'related'],
						[docs.incomingAuto, 'backlinks']
					]) {
						const reason = (await read())[direction].find((d) => d.slug === target.slug).connection;
						assert.equal(
							(
								await changeDocumentTrash({
									expected: await getEditableDocument(target.slug),
									deleted: true
								})
							).status,
							'trashed'
						);
						assert.equal(
							(await read())[direction].some((d) => d.slug === target.slug),
							false
						);
						assert.equal(
							(
								await changeDocumentTrash({
									expected: await getEditableDocument('', target.id, { includeDeleted: true }),
									deleted: false
								})
							).status,
							'restored'
						);
						const before = await snapshot();
						assert.deepEqual(
							(await read())[direction].find((d) => d.slug === target.slug).connection,
							reason
						);
						assert.deepEqual(await snapshot(), before);
					}
					assert.equal((await getEditableDocument('reading-connections')).version, version);
				}
			);
			await t.test(
				'empty and unavailable data are distinct and a recovered read returns real reasons',
				async () => {
					const isolated = await read('isolated');
					assert.deepEqual(isolated.related, []);
					assert.deepEqual(isolated.backlinks, []);
					await sql`ALTER TABLE redirects RENAME TO redirects_unavailable`;
					try {
						await assert.rejects(() => read());
					} finally {
						await sql`ALTER TABLE redirects_unavailable RENAME TO redirects`;
					}
					assert.equal((await read()).related.length, 3);
				}
			);
			assert.equal(externalCalls, 0);
		} finally {
			await state.closeDatabase();
			await server.close();
		}
	}
);
