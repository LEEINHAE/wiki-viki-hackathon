import { fail, redirect, isRedirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getEditableDocument } from '$lib/server/document-write.js';
import {
	changeDocumentTrash,
	isTrashSchemaMissing,
	validDocumentId,
	validDocumentVersion
} from '$lib/server/document-trash.js';

export async function load({ url }) {
	try {
		const [{ count }] =
			await db()`SELECT COUNT(*)::int AS count FROM documents WHERE deleted_at IS NOT NULL`;
		const pages = Math.max(1, Math.ceil(count / 50));
		const requestedPage = Number(url.searchParams.get('page') || 1);
		const page = Math.min(
			pages,
			Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1)
		);
		const documents = await db()`SELECT id,title,slug,deleted_at,deleted_by FROM documents
			WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC,id DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
		const id = url.searchParams.get('open') || String(documents[0]?.id || '');
		const reviewed = validDocumentId(id)
			? await getEditableDocument('', id, { includeDeleted: true })
			: null;
		const selected = reviewed?.document.deleted_at ? reviewed : null;
		return {
			documents,
			page,
			pages,
			count,
			selected: selected
				? { document: selected.document, aliases: selected.aliases, version: selected.version }
				: null,
			missingSelection: !!id && !selected,
			databaseError: null
		};
	} catch {
		return {
			documents: [],
			page: 1,
			pages: 1,
			count: 0,
			selected: null,
			missingSelection: false,
			databaseError: '휴지통을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.'
		};
	}
}

export const actions = {
	restore: async ({ request }) => {
		const form = await request.formData();
		const documentId = form.get('documentId')?.toString() || '';
		const version = form.get('version')?.toString() || '';
		const values = { documentId, version };
		if (!validDocumentId(documentId) || !validDocumentVersion(version))
			return fail(400, {
				...values,
				refreshRequired: true,
				message: '복구할 문서와 검토 버전을 확인해 주세요.'
			});
		try {
			const expected = await getEditableDocument('', documentId, { includeDeleted: true });
			const stale = {
				...values,
				refreshRequired: true,
				message:
					'문서나 별칭의 상태가 변경되어 복구하지 않았습니다. 휴지통의 최신 내용을 다시 검토해 주세요.'
			};
			if (!expected?.document.deleted_at || expected.version !== version) return fail(409, stale);
			const result = await changeDocumentTrash({ expected, deleted: false });
			if (result.status === 'changed') return fail(409, stale);
			if (result.status === 'conflict')
				return fail(409, {
					...values,
					message:
						'다른 문서가 원래 제목·주소·별칭을 사용하고 있어 복구하지 않았습니다. 보관된 문서와 관계는 유지됩니다. 충돌을 해결한 뒤 다시 시도해 주세요.'
				});
			redirect(303, '/wiki/' + encodeURIComponent(result.slug));
		} catch (cause) {
			if (isRedirect(cause)) throw cause;
			if (isTrashSchemaMissing(cause))
				return fail(503, {
					...values,
					message:
						'휴지통 기능에 필요한 서버 업데이트가 적용되지 않아 복구하지 않았습니다. 보관된 문서는 유지됩니다. 관리자에게 업데이트를 요청한 뒤 휴지통을 다시 열어 주세요.'
				});
			return fail(500, {
				...values,
				message:
					'복구 결과를 확인하지 못했습니다. 휴지통과 현재 문서를 확인한 뒤 다시 시도해 주세요.'
			});
		}
	}
};
