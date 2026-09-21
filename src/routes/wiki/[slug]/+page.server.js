import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, renderWiki, buildToc } from '$lib/server/wiki.js';
import { documentRelations } from '$lib/server/discovery.js';
export async function load({ params, url }) {
	let result;
	try {
		result = await getDocument(params.slug, { followMerges: !url.searchParams.has('revision') });
	} catch {
		error(503, '문서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
	}
	if (!result) return { missing: true, slug: params.slug };
	let { document, redirectedFrom, mergedFrom } = result;
	const sql = db();
	const revisionId = url.searchParams.get('revision');
	let revision = null;
	if (revisionId) {
		if (!/^\d+$/.test(revisionId)) error(400, '리비전 번호를 확인해 주세요.');
		[revision] =
			await sql`SELECT id,content,editor_handle,created_at,document_state FROM wv_visible_revisions WHERE id=${revisionId}::bigint AND document_id=${document.id}`;
		if (!revision) error(404, '해당 문서의 리비전을 찾을 수 없습니다.');
		document = {
			...document,
			content: revision.content,
			editor_handle: revision.editor_handle,
			updated_at: revision.created_at,
			...(revision.document_state
				? {
						title: revision.document_state.title || document.title,
						field: revision.document_state.field || document.field,
						description: revision.document_state.description || '',
						source_name: revision.document_state.sourceName || '',
						governance: revision.document_state.governance || {},
						wv_owner_id: revision.document_state.ownerId || null,
						wv_reviewed_at: revision.document_state.reviewedAt || null,
						wv_next_review_on: revision.document_state.nextReviewOn || null
					}
				: {})
		};
	}
	try {
		const [html, relations, threads, contributors, sources, owners] = await Promise.all([
			renderWiki(document.content),
			documentRelations(document.id),
			sql`SELECT count(*) AS count FROM wv_visible_discussions WHERE document_id=${document.id}`,
			sql`SELECT count(DISTINCT editor_handle) AS count FROM wv_visible_revisions WHERE document_id=${document.id}`,
			revision && !Array.isArray(revision.document_state?.sourceIds)
				? []
				: revision
					? sql`SELECT s.id,s.label,s.text,j.file_name FROM wv_upload_sources s JOIN wv_upload_jobs j ON j.id=s.job_id WHERE s.id=ANY(${revision.document_state.sourceIds}::bigint[]) ORDER BY j.id,s.ordinal`
					: sql`SELECT s.id,s.label,s.text,j.file_name FROM wv_document_sources ds JOIN wv_upload_sources s ON s.id=ds.source_id JOIN wv_upload_jobs j ON j.id=s.job_id WHERE ds.document_id=${document.id} ORDER BY j.id,s.ordinal`,
			sql`SELECT handle FROM wv_users WHERE id=${document.wv_owner_id || null}`
		]);
		return {
			missing: false,
			sources,
			ownerHandle: owners[0]?.handle || null,
			document: {
				...document,
				...relations,
				...(revision?.document_state
					? {
							aliases: (revision.document_state.aliases || []).map((a) =>
								typeof a === 'string' ? a : a.title
							),
							tags: revision.document_state.tags || []
						}
					: {})
			},
			redirectedFrom,
			mergedFrom,
			html,
			toc: buildToc(document.content),
			threads: Number(threads[0].count),
			contributors: Number(contributors[0].count),
			revision: revision
				? {
						id: revision.id,
						created_at: revision.created_at,
						hasMetadata: !!revision.document_state
					}
				: null
		};
	} catch (cause) {
		console.error('Document load failed:', cause.code || cause.name);
		error(
			503,
			'문서 연결 정보를 불러오지 못했습니다. 마이그레이션 상태를 확인하거나 잠시 후 다시 시도해 주세요.'
		);
	}
}
