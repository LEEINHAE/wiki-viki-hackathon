import { error } from '@sveltejs/kit';
import JSZip from 'jszip';
import { db } from '$lib/server/db.js';
import { getDocument } from '$lib/server/wiki.js';

export async function GET({ params, url }) {
	const revision = url.searchParams.get('revision');
	if (revision !== null && !/^[1-9]\d{0,18}$/.test(revision))
		error(400, '리비전 번호를 확인해 주세요.');
	const found = await getDocument(params.slug, { followMerges: revision === null });
	if (!found) error(404, '내보낼 문서를 찾을 수 없습니다.');
	// Read the body and its metadata together, rechecking current and historical
	// access in the same statement. An old revision never receives today's state.
	const [row] = await db()`SELECT d.id,d.slug,
		CASE WHEN ${revision}::bigint IS NULL THEN d.content ELSE r.content END AS content,
		CASE WHEN ${revision}::bigint IS NULL THEN wv_document_state_v1(d.id) ELSE r.document_state END AS state,
		CASE WHEN ${revision}::bigint IS NULL THEN d.updated_at ELSE r.created_at END AS version_at,
		CASE WHEN ${revision}::bigint IS NULL THEN (SELECT id FROM wv_visible_revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) ELSE r.id END AS revision_id
		FROM wv_visible_documents d LEFT JOIN wv_visible_revisions r ON r.document_id=d.id AND r.id=${revision}::bigint
		WHERE d.id=${found.document.id} AND d.deleted_at IS NULL AND (${revision}::bigint IS NULL OR r.id IS NOT NULL)`;
	if (!row) error(404, '문서 또는 리비전에 접근할 수 없습니다.');
	const metadata = {
		formatVersion: 1,
		exportedAt: new Date().toISOString(),
		documentId: String(row.id),
		canonicalPath: `/wiki/${encodeURIComponent(row.slug)}`,
		revisionId: row.revision_id ? String(row.revision_id) : null,
		versionAt: row.version_at,
		metadataRecorded: row.state !== null,
		state: row.state,
		note: 'document.md는 선택한 본문 원문입니다. state가 null인 과거 리비전의 메타데이터는 기록되지 않았습니다. 이 파일은 자동 복원 명령이 아닙니다.'
	};
	const zip = new JSZip();
	zip.file('document.md', row.content);
	zip.file('metadata.json', JSON.stringify(metadata, null, 2) + '\n');
	const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
	return new Response(bytes, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="wiki-document-${row.id}-r${row.revision_id || 'current'}.zip"`,
			'cache-control': 'private, no-store'
		}
	});
}
