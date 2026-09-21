import { error, fail, redirect, isHttpError, isRedirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { diffLines } from 'diff';
import { db } from '$lib/server/db.js';
import { createHash } from 'node:crypto';
import { getEditableDocument, editableAliases, saveDocument } from '$lib/server/document-write.js';
import { inspectDocumentContent } from '$lib/server/document-governance.js';
import { parseMergeHistory } from '$lib/merge-history.js';

const versionOf = (snapshot) => createHash('sha256').update(snapshot).digest('hex');
const validId = (id) => /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
const validVersion = (version) => /^[a-f0-9]{64}$/.test(version);

export async function load({ params, url, request }) {
	const fallback = {
		document: null,
		revisions: [],
		selected: null,
		changes: [],
		version: null,
		slug: params.slug,
		semanticAvailable: Boolean(env.OPENAI_API_KEY)
	};
	try {
		const result = await getEditableDocument(params.slug);
		if (!result) {
			if (request?.method === 'POST') return { ...fallback, missingDocument: true };
			error(404, '문서를 찾을 수 없습니다.');
		}
		const rows = await db()`SELECT r.*,to_jsonb(r)::text AS snapshot FROM revisions r
			WHERE document_id=${result.document.id} ORDER BY created_at DESC,id DESC`;
		const revisions = rows.map(({ snapshot, ...revision }) => ({
			...revision,
			merge: parseMergeHistory(revision.summary),
			version: versionOf(snapshot)
		}));
		const index = revisions.findIndex((item) => String(item.id) === url.searchParams.get('diff'));
		return {
			...fallback,
			document: result.document,
			version: result.version,
			revisions,
			selected: index < 0 ? null : String(revisions[index].id),
			changes:
				index < 0 ? [] : diffLines(revisions[index + 1]?.content || '', revisions[index].content)
		};
	} catch (cause) {
		if (isHttpError(cause)) throw cause;
		if (request?.method === 'POST') return { ...fallback, databaseError: true };
		error(503, '문서 이력을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.');
	}
}
export const actions = {
	rollback: async ({ request, params }) => {
		const form = await request.formData();
		const id = form.get('revision')?.toString() || '';
		const documentId = form.get('documentId')?.toString() || '';
		const version = form.get('version')?.toString() || '';
		const revisionVersion = form.get('revisionVersion')?.toString() || '';
		const reviewed = { revision: id, documentId, version, revisionVersion };
		const stale = {
			...reviewed,
			refreshRequired: true,
			message:
				'문서·별칭 또는 복원할 리비전이 변경되어 되돌리지 않았습니다. 최신 이력을 다시 검토해 주세요.'
		};
		if (!validId(id)) return fail(400, { ...stale, message: '되돌릴 리비전을 선택해 주세요.' });
		if (!validId(documentId) || !validVersion(version) || !validVersion(revisionVersion))
			return fail(400, {
				...stale,
				message: '검토한 버전을 확인할 수 없습니다. 최신 이력을 다시 열어 주세요.'
			});
		try {
			const result = await getEditableDocument(params.slug);
			if (!result)
				return fail(404, { ...stale, message: '문서를 찾을 수 없어 되돌리지 않았습니다.' });
			if (String(result.document.id) !== documentId || result.version !== version)
				return fail(409, stale);
			const [revision] = await db()`SELECT r.content,to_jsonb(r)::text AS snapshot FROM revisions r
				WHERE id=${id} AND document_id=${documentId}`;
			if (!revision)
				return fail(404, {
					...stale,
					message: '이 문서의 리비전을 찾을 수 없어 되돌리지 않았습니다.'
				});
			if (versionOf(revision.snapshot) !== revisionVersion) return fail(409, stale);
			const aliases = result.aliases;
			const summary = `리비전 ${id}(으)로 되돌림`;
			const governance = await inspectDocumentContent({
				title: result.document.title,
				content: revision.content,
				aliases: aliases.map((row) => row.alias_title),
				// The revision ID is system metadata, preserved in the saved summary below.
				summary: '선택한 리비전의 본문으로 되돌림'
			});
			if (!governance.passed)
				return fail(governance.semantic.unavailable ? 503 : 400, {
					...reviewed,
					governance,
					message: governance.semantic.unavailable
						? 'AI 의미 검사를 완료하지 못해 되돌리지 않았습니다. 잠시 후 다시 시도해 주세요.'
						: '콘텐츠 보호 검사로 되돌리기가 차단되었습니다. 현재 제목·별칭과 복원할 본문을 확인해 주세요.'
				});
			const saved = await saveDocument({
				title: result.document.title,
				content: revision.content,
				editor: 'Operator-A',
				summary,
				expected: result,
				sourceRevision: { id, snapshot: revision.snapshot },
				requestedSlug: params.slug,
				aliases: editableAliases(
					aliases.map((row) => row.alias_title),
					result.document.slug,
					aliases
				)
			});
			if (saved.status !== 'saved') return fail(409, stale);
			redirect(303, `/wiki/${encodeURIComponent(result.document.slug)}`);
		} catch (cause) {
			if (isRedirect(cause)) throw cause;
			return fail(500, {
				...reviewed,
				message:
					'되돌리기 결과를 확인하지 못했습니다. 문서의 현재 상태를 확인한 뒤 다시 시도해 주세요.'
			});
		}
	}
};
