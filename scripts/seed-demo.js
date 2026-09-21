import postgres from 'postgres';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const editor = 'Operator-A';
const slugify = (value) =>
	value
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/[^\p{L}\p{N}:.~-]/gu, '')
		.replace(/-+/g, '-')
		.toLowerCase();

const documents = [
	{
		title: '예시:장비 인계 절차',
		aliases: ['예시:장비 인수인계'],
		content: `# 장비 인계 절차

이 문서는 공용 장비를 교대조 사이에서 인계하는 예시 절차다. 실제 업무에 적용하기 전 담당 조직의 검토가 필요하다.

## 인계 전

1. 장비 외관에 손상이 없는지 확인한다.
2. 부속품 목록과 실제 수량을 비교한다.
3. 장비의 현재 상태를 인계 기록에 남긴다.

> 이상이 발견된 장비는 사용하지 않고 점검 대기 상태로 구분한다.

## 인계 중

인수자는 장비 표식과 인계 기록을 비교하고 상태를 확인한다. 관련 작업은 [[예시:교대 인계 점검표]]를 함께 참고한다.

## 인계 후

장비는 사용하지 않을 때 지정된 보관 위치에 둔다. 고장이 의심되면 [[예시:정비 요청 절차]]에 따라 점검을 요청한다.[^1]

[^1]: 이 문서는 기능 확인을 위한 샘플이며 실제 운영 규정이 아니다.`
	},
	{
		title: '예시:교대 인계 점검표',
		aliases: ['예시:교대 점검표'],
		content: `# 교대 인계 점검표

## 점검 항목

| 항목 | 확인 사항 | 비고 |
| --- | --- | --- |
| 작업 상태 | 진행 중인 작업 확인 | 다음 조치 기록 |
| 장비 | 공용 장비 상태 확인 | [[예시:장비 인계 절차]] 참고 |
| 작업 공간 | 정리 상태 확인 | 장애물 제거 |
| 미해결 사항 | 미해결 항목 확인 | 담당 역할 지정 |

## 인계 기록 형식

아래와 같은 간결한 형식을 사용한다.

\`\`\`text
상태: 진행 중
다음 조치: 장비 점검
담당자: Operator-A
\`\`\`

~~구두로만 전달~~하지 않고 추적 가능한 기록을 남긴다.`
	},
	{
		title: '예시:정비 요청 절차',
		aliases: ['예시:수리 요청', '예시:정비 요청서'],
		content: `# 정비 요청 절차

장비 이상을 발견했을 때 점검 요청을 등록하고 결과를 추적하는 예시 프로세스다.

## 1. 이상 확인

증상, 발생 시점, 장비 상태를 확인한다. 개인정보나 제한된 정보는 기록하지 않는다.

## 2. 장비 안전 조치

안전하게 분리할 수 있는 경우 장비를 사용 대기 영역에서 분리하고 **점검 대기**로 표시한다.

## 3. 요청 등록

요청에는 다음 정보만 포함한다.

* 장비 유형
* 관찰된 증상
* 요청 시각
* 익명 작업자 이름

## 4. 요청 완료

점검 완료 후 결과를 기록하고 [[예시:장비 인계 절차]]에 따라 장비를 다시 인계한다.`
	},
	{
		title: '예시:증기 시스템 개요',
		aliases: ['예시:증기 개요'],
		content: `# 증기 시스템 개요

이 문서는 Wiki 문법과 문서 연결을 보여주기 위한 일반적인 예시다. 특정 설비의 운전 기준을 제공하지 않는다.

## 구성 요소

| 구성 요소 | 일반적인 역할 |
| --- | --- |
| 보일러 | 물에 열을 전달해 증기를 생성한다. |
| 헤더 | 여러 사용 지점으로 증기를 분배한다. |
| 스팀 트랩 | 응축수 배출을 돕는다. |
| 응축수 회수 설비 | 회수된 응축수를 이동시킨다. |

## 문서화

설비별 절차에는 검증된 운전 범위와 점검 주기를 별도로 기록해야 한다. 용어는 [[예시:운영 용어집]]을 참고한다.

> 실제 설비를 조작할 때는 승인된 현장 절차를 우선한다.`
	},
	{
		title: '예시:운영 용어집',
		aliases: ['예시:운영 용어'],
		content: `# 운영 용어집

## 인계

작업 상태, 장비, 미해결 항목을 다음 작업자에게 전달하는 과정. [[예시:교대 인계 점검표]] 참고.

## 점검 대기

점검이 끝날 때까지 사용해서는 안 되는 상태를 나타내는 예시 표식.

## 리비전

위키 문서가 저장될 때 생성되는 변경 기록. 각 리비전에는 시간, 익명 편집자 이름, 변경 요약이 포함된다.

## 넘겨주기

다른 표현이나 별칭으로 접근했을 때 대표 문서로 연결하는 기능.`
	}
];

// Existing documents (including trash) own their names and routes. Never repair
// their content or aliases from a seed: those may be intentional user edits.
export async function runDemoSeed({ sql, logger = console }) {
	const results = await sql.begin(async (tx) => {
		await tx`SET LOCAL lock_timeout = '10s'`;
		await tx`LOCK TABLE documents, redirects IN SHARE ROW EXCLUSIVE MODE`;
		const results = [];
		let aliasCount = 0;
		for (const item of documents) {
			const slug = slugify(item.title);
			const routes = [slug, ...item.aliases.map(slugify)];
			const names = [item.title, ...item.aliases];
			// A new Read Committed statement after the lock sees writers that
			// committed while this run waited, including cross-table name/route claims.
			const existing = await tx`SELECT d.deleted_at FROM documents d
				WHERE d.title=ANY(${names}::text[]) OR d.slug=ANY(${routes}::text[])
				UNION ALL SELECT d.deleted_at FROM redirects r JOIN documents d ON d.id=r.document_id
				WHERE r.alias_slug=ANY(${routes}::text[]) OR r.alias_title=ANY(${names}::text[])`;
			if (existing.length) {
				results.push({
					title: item.title,
					status: 'skipped',
					archived: existing.some((d) => d.deleted_at)
				});
				continue;
			}
			const inserted = await tx`INSERT INTO documents(slug,title,content,editor_handle)
				VALUES (${slug},${item.title},${item.content},${editor}) RETURNING id`;
			if (inserted.length !== 1) throw new Error('Demo document was not inserted');
			const id = inserted[0].id;
			const revisions = await tx`INSERT INTO revisions(document_id,content,editor_handle,summary)
				VALUES (${id},${item.content},${editor},'예시 문서 생성') RETURNING id`;
			if (revisions.length !== 1) throw new Error('Demo revision was not inserted');
			for (const alias of item.aliases) {
				const aliases = await tx`INSERT INTO redirects(alias_slug,alias_title,document_id)
					VALUES (${slugify(alias)},${alias},${id}) RETURNING id`;
				if (aliases.length !== 1) throw new Error('Demo alias was not inserted');
				aliasCount++;
			}
			results.push({ title: item.title, status: 'created', id });
		}
		const ids = results.filter((item) => item.status === 'created').map((item) => item.id);
		if (ids.length) {
			// RETURNING alone does not detect a later trigger removing inserted rows.
			const [counts] = await tx`SELECT
				(SELECT COUNT(*)::int FROM documents WHERE id=ANY(${ids}::bigint[])) AS documents,
				(SELECT COUNT(*)::int FROM revisions WHERE document_id=ANY(${ids}::bigint[])) AS revisions,
				(SELECT COUNT(*)::int FROM redirects WHERE document_id=ANY(${ids}::bigint[])) AS aliases`;
			if (
				counts.documents !== ids.length ||
				counts.revisions !== ids.length ||
				counts.aliases !== aliasCount
			)
				throw new Error('Demo batch was not fully stored');
		}
		return results;
	});
	// No success/count output is emitted until the complete batch commits.
	for (const item of results)
		logger.log(
			`${item.title}: ${item.status === 'created' ? '생성 완료' : '기존 문서·주소 보존으로 건너뜀'}`
		);
	const created = results.filter((item) => item.status === 'created').length;
	const archived = results.filter((item) => item.archived).length;
	logger.log(
		`예시 문서: 생성 ${created}개, 기존 데이터 보존으로 건너뜀 ${results.length - created}개 (휴지통 보존으로 건너뜀 ${archived}개).`
	);
	return results;
}

async function main() {
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL이 필요합니다. 예시 적재 대상 연결을 설정해 주세요.');
		process.exitCode = 1;
		return;
	}
	const sql = postgres(process.env.DATABASE_URL, {
		max: 1,
		connect_timeout: 10,
		onnotice: () => {}
	});
	try {
		await runDemoSeed({ sql });
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// Match the migration CLI boundary for a disconnected driver's deferred write.
	process.once('uncaughtException', () => {
		writeSync(2, '예시 적재가 중단되었습니다. DB 상태를 확인한 뒤 다시 실행해 주세요.\n');
		process.exit(1);
	});
	main().catch(() => {
		console.error(
			'예시 문서 적재를 완료하지 못했습니다. DB 연결·마이그레이션·잠금 상태를 확인한 뒤 다시 실행해 주세요.'
		);
		process.exitCode = 1;
	});
}
