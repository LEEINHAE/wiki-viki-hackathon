import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { slugify } from '../src/lib/knowledge.js';
import { seedFiles } from './lib/seed-files.js';

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

async function seedCore(sql) {
	return sql.begin(async (tx) => {
		// This short initialization transaction contains no file or AI work. Table
		// locks also wait for writers that do not participate in a seed advisory lock,
		// so an in-flight alias or edit is visible before we check names and routes.
		await tx`SET LOCAL lock_timeout = '10s'`;
		await tx`LOCK TABLE documents, redirects, announcements IN SHARE ROW EXCLUSIVE MODE`;
		let created = 0;
		for (const [title, content] of core) {
			const slug = slugify(title);
			const [doc] = await tx`
				INSERT INTO documents (slug,title,content,editor_handle)
				SELECT ${slug},${title},${content},'Operator-A'
				WHERE NOT EXISTS (SELECT 1 FROM documents WHERE slug=${slug} OR title=${title})
				AND NOT EXISTS (SELECT 1 FROM redirects WHERE alias_slug=${slug} OR alias_title=${title})
				ON CONFLICT DO NOTHING RETURNING id`;
			if (!doc) continue;
			await tx`INSERT INTO revisions (document_id,content,editor_handle,summary)
				VALUES (${doc.id},${content},'Operator-A','초기 문서 생성')`;
			created += 1;
		}
		await tx`INSERT INTO announcements (title,body)
			SELECT 'Wiki Viki에 오신 것을 환영합니다','문서를 작성하기 전에 기본 정책을 확인해 주세요.'
			WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title='Wiki Viki에 오신 것을 환영합니다')`;
		return { created, skipped: core.length - created };
	});
}

export async function runSeed({
	sql,
	directory,
	apiKey = '',
	model = 'gpt-5-mini',
	logger = console
}) {
	const coreStats = await seedCore(sql);
	logger.log(
		`기본 문서: 생성 ${coreStats.created}개, 기존 문서·별칭 보존으로 건너뜀 ${coreStats.skipped}개.`
	);
	return seedFiles({ sql, directory, apiKey, model, logger });
}

async function main() {
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL이 필요합니다. 먼저 마이그레이션을 실행하세요.');
		process.exitCode = 1;
		return;
	}
	const sql = postgres(process.env.DATABASE_URL, { max: 1 });
	try {
		const stats = await runSeed({
			sql,
			apiKey: process.env.OPENAI_API_KEY,
			model: process.env.OPENAI_MODEL || 'gpt-5-mini'
		});
		if (stats.failed) process.exitCode = 1;
	} finally {
		await sql.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(() => {
		console.error('시드 작업을 완료하지 못했습니다. 데이터베이스와 원본 폴더를 확인해 주세요.');
		process.exitCode = 1;
	});
}
