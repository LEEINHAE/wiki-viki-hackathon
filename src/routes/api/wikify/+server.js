import { json } from '@sveltejs/kit';
import { validateDraftDocuments } from '$lib/knowledge.js';
import { supportsUpload, uploadFormatMessage } from '$lib/upload.js';
import { parseUpload } from '$lib/server/parser.js';
import { structureDocuments, semanticGovernance } from '$lib/server/openai.js';
import {
	assertSafeForAI,
	ContentBlockedError,
	regexGovernance,
	validHandle
} from '$lib/server/governance.js';
import { db } from '$lib/server/db.js';
import { autoLinkDocument } from '$lib/server/wiki.js';

export async function POST({ request }) {
	try {
		const form = await request.formData();
		const file = form.get('file');
		const editor = form.get('editor')?.toString();
		if (!(file instanceof File) || !file.size)
			return json({ message: uploadFormatMessage }, { status: 400 });
		if (!supportsUpload(file.name)) return json({ message: uploadFormatMessage }, { status: 400 });
		if (file.size > 10 * 1024 * 1024)
			return json({ message: '파일 크기는 10MB 이하여야 합니다.' }, { status: 413 });
		if (!validHandle(editor))
			return json({ message: '익명 편집자 이름을 사용해 주세요.' }, { status: 400 });
		let text;
		try {
			text = await parseUpload(file);
		} catch {
			return json(
				{
					message:
						'파일을 읽을 수 없습니다. 암호가 없는 올바른 DOCX·PDF·XLSX·PPTX 파일인지 확인해 주세요.'
				},
				{ status: 422 }
			);
		}
		if (!text)
			return json(
				{ message: '텍스트를 추출할 수 없습니다. OCR은 지원하지 않습니다.' },
				{ status: 422 }
			);
		const regex = assertSafeForAI(file.name, text);
		const semantic = await semanticGovernance(`${file.name}\n${text}`);
		if (semantic.unavailable)
			return json(
				{ message: '콘텐츠 보호 검사 결과를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' },
				{ status: 503 }
			);
		if (!semantic.passed) throw new ContentBlockedError();
		const structured = await structureDocuments(text, file.name);
		const documents = validateDraftDocuments(structured.documents);
		const candidates = await Promise.all(
			documents.map(async (document) => {
				const content = await autoLinkDocument(
					document.sections
						.map((section) => `## ${section.heading}\n\n${section.content}`)
						.join('\n\n'),
					document.suggestedLinks,
					documents.filter((other) => other.slug !== document.slug).map((other) => other.title)
				);
				const generated = regexGovernance(document.title + '\n' + content);
				const governance = {
					passed: regex.passed && semantic.passed && generated.passed,
					regex: {
						passed: regex.passed && generated.passed,
						reasons: [...new Set([...regex.reasons, ...generated.reasons])]
					},
					semantic
				};
				return {
					...document,
					content,
					governance,
					status: governance.passed ? 'review' : 'blocked'
				};
			})
		);
		const sql = db();
		const rows = await sql.transaction(
			(tx) =>
				candidates.map(
					(draft) =>
						tx`INSERT INTO drafts (title,slug,content,source_name,aliases,governance,status,editor_handle) VALUES (${draft.title},${draft.slug},${draft.content},${file.name},${JSON.stringify(draft.aliases)},${JSON.stringify(draft.governance)},${draft.status},${editor}) RETURNING id,title,status`
				),
			{ isolationLevel: 'ReadCommitted' }
		);
		const drafts = rows.map(([row], index) => ({
			...row,
			linkCount: [...candidates[index].content.matchAll(/\[\[([^\]]+)\]\]/g)].length
		}));
		return json(
			{
				drafts,
				count: drafts.length,
				aiGenerated: structured.aiGenerated,
				semanticSkipped: semantic.skipped === true
			},
			{ status: 201 }
		);
	} catch (error) {
		if (error instanceof ContentBlockedError)
			return json({ message: error.message }, { status: 422 });
		if (error.status === 429)
			return json(
				{
					message:
						'AI 서비스의 이용 한도에 도달했습니다. 관리자에게 확인을 요청한 뒤 다시 시도해 주세요.'
				},
				{ status: 503 }
			);
		return json(
			{
				message: '초안을 만들지 못했습니다. 파일 내용과 연결 상태를 확인한 뒤 다시 시도해 주세요.'
			},
			{ status: 500 }
		);
	}
}
