import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import OpenAI from 'openai';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다. 먼저 마이그레이션을 실행하세요.');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const slugify = (value) => value.trim().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}:.~-]/gu, '').replace(/-+/g, '-').toLowerCase();
const blocked = (text) => /\bconfidential\b|대외비|기밀|급여|연봉|\b(?:salary|payroll)\b|\b\d{6}-[1-4]\d{6}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(text);
const core = [
	['Wiki Viki:기본 정책','# 기본 정책\n\nWiki Viki는 함께 사용하는 업무 지식을 저장합니다. 검증할 수 있는 정보를 작성하고, 개인정보를 보호하며, 협업을 통해 문서를 개선해 주세요.\n\n## 핵심 원칙\n\n* 익명 편집자 이름을 사용합니다.\n* 개인정보나 접근이 제한된 정보를 게시하지 않습니다.\n* 의견이 엇갈리는 편집은 되돌리기 전에 먼저 토론합니다.'],
	['Wiki Viki:편집 지침','# 편집 지침\n\n## 작성 방식\n\n명확한 제목과 간결한 문장을 사용하고, 관련 개념은 [[Wiki Viki:기본 정책|위키 링크]]로 연결합니다. 확인 가능한 출처가 있다면 함께 기록합니다.[^1]\n\n## 문법\n\n| 문법 | 결과 |\n| --- | --- |\n| `[[문서]]` | 위키 링크 |\n| `~~텍스트~~` | ~~취소선~~ |\n\n[^1]: AI가 생성한 초안은 담당자의 검토가 필요합니다.'],
	['Wiki Viki:토론','# 토론\n\n각 문서의 **토론** 메뉴에서 변경을 제안하고, 서로 다른 의견을 기록하며, 합의점을 찾아 주세요.'],
	['Wiki Viki:도움말','# 도움말\n\n## 문서 찾기\n\n상단 메뉴의 검색창을 사용하세요. 빨간색 링크는 아직 존재하지 않는 문서를 가리킵니다.\n\n## 문서 만들기와 편집\n\n빨간색 링크를 누르거나 기존 문서에서 **편집**을 선택하세요. 저장할 때마다 새로운 리비전이 생성됩니다.'],
	['Wiki Viki:최근 변경','# 최근 변경\n\n이 시스템은 모든 문서 변경 사항을 기록합니다. 사이드바와 문서 역사에서 최근 작업 내용을 확인할 수 있습니다.']
];

async function upsert(title, content) {
	const [doc] = await sql`INSERT INTO documents (slug,title,content,editor_handle) VALUES (${slugify(title)},${title},${content},'Operator-A') ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,updated_at=NOW() RETURNING *`;
	await sql`INSERT INTO revisions (document_id,content,editor_handle,summary) VALUES (${doc.id},${content},'Operator-A','초기 문서 생성')`;
}

async function parse(path, ext) {
	const data = await readFile(path);
	if (ext === '.docx') return (await mammoth.extractRawText({ buffer: data })).value;
	const parser = new PDFParse({ data }); try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

async function structure(text, name) {
	if (!process.env.OPENAI_API_KEY) return { title: basename(name, extname(name)), sections: [{ heading: '개요', content: text }], aliases: [] };
	const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	const response = await ai.responses.create({ model: process.env.OPENAI_MODEL || 'gpt-5-mini', input: `원문에 없는 사실을 추가하지 말고 한국어 사내 위키 초안으로 정리하세요. title, sections[{heading,content}], aliases[]를 포함한 JSON을 반환하세요.\n\n${text}` });
	return JSON.parse(response.output_text);
}

try {
	for (const [title, content] of core) await upsert(title, content);
	await sql`INSERT INTO announcements (title,body) SELECT 'Wiki Viki에 오신 것을 환영합니다','문서를 작성하기 전에 기본 정책을 확인해 주세요.' WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title='Wiki Viki에 오신 것을 환영합니다')`;
	let files = []; try { files = (await readdir(new URL('../seed-data/', import.meta.url))).filter((name) => ['.docx','.pdf'].includes(extname(name).toLowerCase())); } catch {}
	for (const file of files) {
		try { const text = await parse(new URL(`../seed-data/${file}`, import.meta.url), extname(file).toLowerCase()); const result = await structure(text, file); const content = result.sections.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n'); const status = blocked(text) ? 'blocked' : 'review'; await sql`INSERT INTO drafts (title,slug,content,source_name,aliases,governance,status,editor_handle) VALUES (${result.title},${slugify(result.title)},${content},${file},${sql.json(result.aliases || [])},${sql.json({ passed: status === 'review', seed: true })},${status},'Operator-A')`; console.log(`${file} 초안 생성 완료`); }
		catch (error) { console.error(`${file} 처리 실패: ${error.message}`); }
	}
	console.log(`기본 문서 ${core.length}개 생성 및 원본 파일 ${files.length}개 처리 완료`);
} finally { await sql.end(); }
