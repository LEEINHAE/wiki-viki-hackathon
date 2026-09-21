import { openDatabase } from './database.js';
import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import { seedDocument } from './seed-helpers.js';
import { createAI } from '../src/lib/server/openai-core.js';
import { parseUploadDetailed } from '../src/lib/server/parser.js';
import { inspectContent, assertSafeForAI } from '../src/lib/content-policy.js';
import { slugify, excerpt } from '../src/lib/wiki-utils.js';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
const sql = openDatabase();
const ai = createAI(process.env);
const core = [
	[
		'Wiki Viki:기본 정책',
		'# 기본 정책\n\nWiki Viki는 함께 사용하는 업무 지식을 저장합니다. 검증할 수 있는 정보를 작성하고, 개인정보를 보호하며, 협업을 통해 문서를 개선해 주세요.\n\n## 핵심 원칙\n\n* 익명 편집자 이름을 사용합니다.\n* 개인정보나 접근이 제한된 정보를 게시하지 않습니다.\n* 의견이 엇갈리는 편집은 되돌리기 전에 먼저 토론합니다.'
	],
	[
		'Wiki Viki:편집 지침',
		'# 편집 지침\n\n## 작성 방식\n\n명확한 제목과 간결한 문장을 사용하고, 관련 개념은 [[Wiki Viki:기본 정책|위키 링크]]로 연결합니다. 확인 가능한 출처가 있다면 함께 기록합니다.[^1]\n\n## 문법\n\n| 문법 | 결과 |\n| --- | --- |\n| `[[문서]]` | 위키 링크 |\n| `~~텍스트~~` | ~~취소선~~ |\n\n[^1]: AI가 생성한 초안은 담당자의 검토가 필요합니다.'
	],
	[
		'Wiki Viki:토론',
		'# 토론\n\n각 문서의 **토론** 메뉴에서 변경을 제안하고, 서로 다른 의견을 기록하며, 합의점을 찾아 주세요.'
	],
	[
		'Wiki Viki:도움말',
		'# 도움말\n\n## 문서 찾기\n\n상단 메뉴의 검색창을 사용하세요. 빨간색 링크는 아직 존재하지 않는 문서를 가리킵니다.\n\n## 문서 만들기와 편집\n\n빨간색 링크를 누르거나 기존 문서에서 **편집**을 선택하세요. 저장할 때마다 새로운 리비전이 생성됩니다.'
	],
	[
		'Wiki Viki:최근 변경',
		'# 최근 변경\n\n이 시스템은 모든 문서 변경 사항을 기록합니다. 사이드바와 문서 역사에서 최근 작업 내용을 확인할 수 있습니다.'
	]
];

try {
	let created = 0;
	for (const [title, content] of core) {
		const result = await sql.begin((tx) =>
			seedDocument(tx, {
				title,
				content,
				aliases: title.endsWith('기본 정책')
					? ['Wiki Viki:basic-policy']
					: title.endsWith('도움말')
						? ['Wiki Viki:help']
						: [],
				field: '일반',
				sourceName: 'Wiki Viki 이용 안내'
			})
		);
		if (result.created) created++;
	}
	await sql`INSERT INTO announcements(title,body) SELECT 'Wiki Viki에 오신 것을 환영합니다','문서를 작성하기 전에 기본 정책을 확인해 주세요.' WHERE NOT EXISTS(SELECT 1 FROM announcements WHERE title='Wiki Viki에 오신 것을 환영합니다')`;
	let files = [];
	try {
		files = (await readdir(new URL('../seed-data/', import.meta.url))).filter((name) =>
			['.docx', '.pdf', '.xlsx', '.pptx'].includes(extname(name).toLowerCase())
		);
	} catch {}
	let drafts = 0,
		failed = 0;
	for (const name of files) {
		try {
			const bytes = await readFile(new URL(`../seed-data/${name}`, import.meta.url));
			const fingerprint = createHash('sha256').update(bytes).digest('hex');
			if (
				(
					await sql`SELECT id FROM drafts WHERE governance->>'seedFingerprint'=${fingerprint} LIMIT 1`
				).length
			)
				continue;
			const parsed = await parseUploadDetailed(new File([bytes], name));
			if (!parsed.text.trim()) throw Error('empty_source');
			assertSafeForAI(name, parsed.text);
			const sourceCheck = await inspectContent([name, parsed.text], ai.semanticGovernance);
			if (!sourceCheck.passed) throw Error('seed_content_blocked');
			const structured = await ai.structureDocuments(parsed.text, name);
			const records = [];
			for (const item of structured.documents) {
				const content = item.sections.map((s) => `## ${s.heading}\n\n${s.content}`).join('\n\n');
				const governance = await inspectContent(
					[name, item.title, content, item.description, ...item.aliases],
					structured.mode === 'ai' ? ai.semanticGovernance : null
				);
				records.push({
					...item,
					content,
					governance: {
						...governance,
						generationMode: structured.mode,
						seed: true,
						seedFingerprint: fingerprint
					}
				});
			}
			await sql.begin(async (tx) => {
				await tx`SELECT set_config('wv.operator','1',true)`;
				await tx`SELECT pg_advisory_xact_lock(21470921,2)`;
				if (
					(
						await tx`SELECT id FROM drafts WHERE governance->>'seedFingerprint'=${fingerprint} LIMIT 1`
					).length
				)
					return;
				for (const item of records) {
					await tx`INSERT INTO drafts(title,slug,content,source_name,aliases,governance,status,editor_handle,field,description) VALUES(${item.title},${slugify(item.title)},${item.content},${name},${tx.json(item.aliases || [])},${tx.json(item.governance)},${item.governance.passed ? 'review' : 'blocked'},'Operator-A',${item.field || '일반'},${item.description || excerpt(item.content)})`;
					drafts++;
				}
			});
		} catch (cause) {
			failed++;
			console.error('원본 파일 처리 실패:', cause.code || cause.name);
		}
	}
	console.log(
		`안내 ${created}개 추가, 초안 ${drafts}개 추가, 파일 ${failed}개 실패. 기존 문서 본문은 변경하지 않았습니다.`
	);
} finally {
	await sql.end();
}
