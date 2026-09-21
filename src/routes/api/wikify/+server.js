import { json } from '@sveltejs/kit';
import { parseUpload } from '$lib/server/parser.js';
import { structureDocument, semanticGovernance } from '$lib/server/openai.js';
import { regexGovernance, validHandle } from '$lib/server/governance.js';
import { db } from '$lib/server/db.js';
import { autoLinkDocument, slugify } from '$lib/server/wiki.js';

export async function POST({ request }) {
	try {
		const form = await request.formData(); const file = form.get('file'); const editor = form.get('editor')?.toString();
		if (!(file instanceof File) || !file.size) return json({ message: 'DOCX 또는 PDF 파일을 선택해 주세요.' }, { status: 400 });
		if (file.size > 10 * 1024 * 1024) return json({ message: '파일 크기는 10MB 이하여야 합니다.' }, { status: 413 });
		if (!validHandle(editor)) return json({ message: '익명 편집자 이름을 사용해 주세요.' }, { status: 400 });
		const text = await parseUpload(file); if (!text) return json({ message: '텍스트를 추출할 수 없습니다. OCR은 지원하지 않습니다.' }, { status: 422 });
		const regex = regexGovernance(text); const semantic = regex.passed ? await semanticGovernance(text) : { passed: false, reasons: ['키워드 검사에 통과하지 못해 의미 기반 검사를 건너뛰었습니다.'] };
		const structured = await structureDocument(text, file.name);
		let content = structured.sections.map((section) => `## ${section.heading}\n\n${section.content}`).join('\n\n');
		content = await autoLinkDocument(content, structured.suggestedLinks);
		const governance = { passed: regex.passed && semantic.passed, regex, semantic };
		const [draft] = await db()`INSERT INTO drafts (title,slug,content,source_name,aliases,governance,status,editor_handle) VALUES (${structured.title},${slugify(structured.title)},${content},${file.name},${db().json(structured.aliases)},${db().json(governance)},${governance.passed ? 'review' : 'blocked'},${editor}) RETURNING id,title,status`;
		return json(draft, { status: 201 });
	} catch (error) { return json({ message: error.message || '초안을 만들 수 없습니다.' }, { status: 500 }); }
}
