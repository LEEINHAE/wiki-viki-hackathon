import { fail, redirect, isRedirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { slugify } from '$lib/server/wiki.js';
import { getEditableDocument, editableAliases, saveDocument } from '$lib/server/document-write.js';
import {
	changeDocumentTrash,
	validDocumentId,
	validDocumentVersion
} from '$lib/server/document-trash.js';
import { validHandle } from '$lib/server/governance.js';
import { inspectDocumentContent } from '$lib/server/document-governance.js';

export async function load({ params, url }) {
	const semanticAvailable = Boolean(env.OPENAI_API_KEY);
	const requestedTitle = url?.searchParams.get('title')?.trim();
	const initialTitle =
		requestedTitle && requestedTitle.length <= 200 && slugify(requestedTitle) === params.slug
			? requestedTitle
			: undefined;
	try {
		const result = await getEditableDocument(params.slug, null, { includeDeleted: true });
		if (result?.document.deleted_at)
			return {
				slug: params.slug,
				semanticAvailable,
				document: null,
				aliases: '',
				version: null,
				trashed: { id: result.document.id }
			};
		const aliases = result?.aliases || [];
		return {
			slug: params.slug,
			initialTitle: result ? undefined : initialTitle,
			semanticAvailable,
			document: result?.document || null,
			aliases: aliases.map((row) => row.alias_title).join('\n'),
			version: result?.version || 'new'
		};
	} catch {
		return {
			slug: params.slug,
			initialTitle,
			semanticAvailable,
			document: null,
			databaseError: '문서를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.'
		};
	}
}
export const actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const values = Object.fromEntries(
			[
				'title',
				'content',
				'editor',
				'summary',
				'aliases',
				'version',
				'documentId',
				'aliasesFormat'
			].map((key) => [key, form.get(key)?.toString() || ''])
		);
		if (form.has('resolveVersion')) values.version = form.get('resolveVersion')?.toString() || '';
		const title = values.title.trim();
		const content = values.content;
		const editor = values.editor.trim();
		const summary = values.summary.trim();
		const aliases = values.aliases
			.split(values.aliasesFormat === 'lines' ? /\r?\n/ : ',')
			.map((value) => value.trim())
			.filter(Boolean);
		if (!title || !content.trim())
			return fail(400, {
				message: '제목과 내용을 모두 입력해 주세요.',
				...values
			});
		if (!validHandle(editor))
			return fail(400, {
				message: 'Editor-01 또는 Operator-A 형식의 익명 이름을 사용해 주세요.',
				...values
			});
		if (
			(values.documentId &&
				(!/^[1-9]\d{0,18}$/.test(values.documentId) ||
					BigInt(values.documentId) > 9223372036854775807n)) ||
			(values.documentId ? !/^[a-f0-9]{64}$/.test(values.version) : values.version !== 'new')
		)
			return fail(400, {
				...values,
				message:
					'편집을 시작한 문서 버전을 확인할 수 없습니다. 입력을 보관하고 편집 화면을 다시 열어 주세요.'
			});
		let governance;
		try {
			const expected = await getEditableDocument(params.slug, values.documentId || null);
			const changed = async () => {
				const current = values.documentId
					? await getEditableDocument(params.slug, values.documentId)
					: null;
				return fail(409, {
					...values,
					message: current
						? '다른 변경이 먼저 저장되었습니다. 입력을 유지했습니다. 현재 저장본과 비교한 뒤 다시 저장해 주세요.'
						: '문서가 삭제되었거나 이 주소에 다른 문서가 생성되었습니다. 입력을 유지했습니다. 문서의 현재 상태를 확인해 주세요.',
					conflict: current
						? {
								title: current.document.title,
								content: current.document.content,
								aliases: current.aliases.map((row) => row.alias_title),
								version: current.version,
								slug: current.document.slug
							}
						: null,
					missingTarget: !current
				});
			};
			if (values.documentId ? !expected || expected.version !== values.version : expected)
				return changed();
			const slug = expected?.document.slug || slugify(title);
			const prepared = editableAliases(aliases, slug, expected?.aliases);
			if (!/[\p{L}\p{N}]/u.test(slugify(title)) || !prepared)
				return fail(400, {
					...values,
					message: '제목과 별칭에 주소로 사용할 수 있는 글자나 숫자를 포함해 주세요.'
				});
			governance = await inspectDocumentContent({ title, content, aliases, summary });
			if (!governance.passed)
				return fail(governance.semantic.unavailable ? 503 : 400, {
					message: governance.semantic.unavailable
						? 'AI 의미 검사를 완료하지 못해 저장하지 않았습니다. 입력 내용을 유지했습니다. 잠시 후 다시 저장해 주세요.'
						: '콘텐츠 보호 검사로 저장이 차단되었습니다. 안내된 내용을 수정해 주세요.',
					...values,
					governance
				});
			const saved = await saveDocument({
				title,
				content,
				editor,
				summary,
				expected,
				requestedSlug: params.slug,
				aliases: prepared
			});
			if (saved.status === 'changed') return changed();
			if (saved.status === 'conflict')
				return fail(409, {
					...values,
					message:
						'다른 문서가 같은 제목·주소·별칭을 사용하고 있습니다. 입력을 유지했습니다. 제목이나 별칭을 수정해 주세요.'
				});
			redirect(303, `/wiki/${encodeURIComponent(saved.slug)}`);
		} catch (error) {
			if (isRedirect(error)) throw error;
			return fail(error.code === '23505' ? 409 : 500, {
				message:
					error.code === '23505'
						? '같은 제목·주소·별칭이 먼저 사용되었습니다. 입력을 유지했습니다. 현재 문서를 확인해 주세요.'
						: '저장 완료를 확인하지 못했습니다. 입력 내용을 유지했습니다. 문서의 현재 상태를 확인한 뒤 다시 시도해 주세요.',
				...values,
				governance
			});
		}
	},
	delete: async ({ request, params }) => {
		const submitted = await request.formData();
		const values = Object.fromEntries(
			[
				'title',
				'content',
				'editor',
				'summary',
				'aliases',
				'version',
				'documentId',
				'aliasesFormat'
			].map((key) => [key, submitted.get(key)?.toString() || ''])
		);
		if (submitted.get('confirmDelete') !== 'yes')
			return fail(400, {
				...values,
				message: '문서를 휴지통으로 이동한다는 확인 항목을 선택해 주세요.'
			});
		if (
			!validDocumentId(values.documentId) ||
			!validDocumentVersion(values.version) ||
			!validHandle(values.editor.trim())
		)
			return fail(400, { ...values, message: '문서 버전과 익명 편집자 이름을 확인해 주세요.' });
		try {
			const expected = await getEditableDocument(params.slug);
			const changed = {
				...values,
				deleteReviewRequired: true,
				message:
					'문서나 별칭의 상태가 변경되어 휴지통으로 이동하지 않았습니다. 입력을 보관하고 현재 문서를 다시 확인해 주세요.'
			};
			if (
				!expected ||
				String(expected.document.id) !== values.documentId ||
				expected.version !== values.version
			)
				return fail(409, changed);
			const result = await changeDocumentTrash({
				expected,
				deleted: true,
				editor: values.editor.trim()
			});
			if (result.status !== 'trashed') return fail(409, changed);
			redirect(303, '/trash?open=' + values.documentId);
		} catch (cause) {
			if (isRedirect(cause)) throw cause;
			return fail(500, {
				...values,
				message:
					'휴지통 이동 결과를 확인하지 못했습니다. 입력을 유지했습니다. 문서의 현재 상태를 확인한 뒤 다시 시도해 주세요.'
			});
		}
	}
};
