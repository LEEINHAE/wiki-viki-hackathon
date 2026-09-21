import { openDatabase } from './database.js';
import { seedPrototype } from './prototype-seed.js';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL이 필요합니다.');
const sql = openDatabase();
try {
	const result = await sql.begin(seedPrototype);
	console.log(
		`업무 예시 문서 ${result.documents}개, 검토 대기 초안 ${result.drafts}개 추가. 기존 자료는 보존했습니다.`
	);
} finally {
	await sql.end();
}
