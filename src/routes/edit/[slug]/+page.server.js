import { actorHandle } from '$lib/server/auth.js';
import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { getDocument, slugify } from '$lib/server/wiki.js';
import { validHandle, inspectContent } from '$lib/server/governance.js';
import { semanticGovernance, aiErrorMessage } from '$lib/server/openai.js';
import { persistDocument, writeFailure } from '$lib/server/persistence.js';
import { fields } from '$lib/wiki-utils.js';

export async function load({ params, url }) {
	try {
		const result = await getDocument(params.slug);
		const aliases = result
			? await db()`SELECT alias_title FROM redirects WHERE document_id=${result.document.id} ORDER BY alias_title`
			: [];
		return {
			slug: params.slug,
			section: url.searchParams.get('section') || '',
			document: result?.document || null,
			suggestedTitle: url.searchParams.get('title'),
			aliases: aliases.map((row) => row.alias_title).join(', '),
			tags: result
				? (
						await db()`SELECT tag FROM wv_document_tags WHERE document_id=${result.document.id} ORDER BY tag`
					)
						.map((t) => t.tag)
						.join(', ')
				: ''
		};
	} catch {
		return {
			slug: params.slug,
			document: null,
			databaseError: '문서를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.'
		};
	}
}
export const actions = {
	save: async ({ request, params }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		const title = String(values.title || '').trim();
		const content = String(values.content || '');
		const editor = String(values.editor || '').trim();
		const summary = String(values.summary || '').trim();
		const aliases = String(values.aliases || '');
		const field = String(values.field || '일반');
		const description = String(values.description || '').trim();
		const sourceName = String(values.sourceName || '').trim();
		const tags = [
			...new Set(
				String(values.tags || '')
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			)
		];
		const invalid = (status, message, extra = {}) => fail(status, { ...values, message, ...extra });
		if (
			!title ||
			!content.trim() ||
			!slugify(title) ||
			title.length > 200 ||
			content.length > 200000 ||
			aliases.length > 5000 ||
			summary.length > 2000 ||
			description.length > 2000 ||
			sourceName.length > 500 ||
			tags.length > 20 ||
			tags.some((t) => t.length > 40)
		)
			return invalid(
				400,
				'제목(200자 이하)과 본문(20만 자 이하)을 입력하고 별칭·요약 길이를 확인해 주세요.'
			);
		if (!validHandle(editor)) return invalid(400, '올바른 익명 편집자 이름을 입력해 주세요.');
		if (!fields.includes(field)) return invalid(400, '올바른 분야를 선택해 주세요.');
		let document;
		try {
			const existing = await getDocument(params.slug);
			if (existing && String(values.id || '') !== String(existing.document.id))
				return invalid(
					409,
					'작성 중 같은 주소의 문서가 생성되었습니다. 기존 문서를 확인해 주세요.'
				);
			if (!existing && values.id)
				return invalid(409, '문서가 휴지통으로 이동되었습니다. 휴지통을 확인해 주세요.');
			const governance = await inspectContent(
				[title, content, description, sourceName, aliases, summary, ...tags],
				semanticGovernance
			);
			if (!governance.passed)
				return invalid(
					400,
					`콘텐츠 검사로 차단되었습니다: ${[...governance.regex.reasons, ...governance.semantic.reasons].join(', ')}`
				);
			document = await persistDocument({
				id: existing?.document.id,
				version: values.version,
				title,
				content,
				editor,
				summary,
				aliases,
				tags,
				slug: existing?.document.slug || slugify(title),
				field,
				description,
				sourceName,
				governance
			});
		} catch (cause) {
			const failure = cause.status
				? { status: 503, message: aiErrorMessage(cause) }
				: writeFailure(cause);
			const latest =
				failure.status === 409 ? await getDocument(params.slug).catch(() => null) : null;
			return invalid(failure.status, failure.message, { latest: latest?.document || null });
		}
		redirect(303, `/wiki/${encodeURIComponent(document.slug)}`);
	},
	delete: async ({ params, request }) => {
		const values = Object.fromEntries(await request.formData());
		values.editor = actorHandle(values.editor);
		if (!validHandle(values.editor))
			return fail(400, { message: '올바른 익명 편집자 이름을 입력해 주세요.' });
		try {
			const result = await getDocument(params.slug);
			if (!result) return fail(404, { message: '문서를 찾을 수 없습니다.' });
			await db()`SELECT wv_trash_document_v1(${result.document.id}, ${String(values.version || '')}, ${values.editor}, false)`;
		} catch (cause) {
			const failure = writeFailure(cause);
			return fail(failure.status, failure);
		}
		redirect(303, '/trash');
	}
};
