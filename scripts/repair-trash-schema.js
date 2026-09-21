import postgres from 'postgres';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { repairTrashSchema, TrashSchemaError } from './lib/trash-schema.js';

async function main() {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length && !['--check', '--apply'].includes(args[0])))
		throw new TrashSchemaError('사용법: bun run repair:trash [--check | --apply]');
	if (!process.env.DATABASE_URL)
		throw new TrashSchemaError('DATABASE_URL에 점검할 DB 연결을 설정해 주세요.');
	const sql = postgres(process.env.DATABASE_URL, {
		max: 1,
		connect_timeout: 10,
		onnotice: () => {}
	});
	try {
		const result = await repairTrashSchema({ sql, apply: args[0] === '--apply' });
		if (result.status === 'missing-lifecycle-version') {
			console.log(
				'휴지통 버전 열이 누락되어 있습니다. 변경하지 않았습니다. 대상 DB를 확인한 뒤 --apply로 보정하세요.'
			);
			process.exitCode = 2;
		} else if (result.status === 'repaired') {
			console.log('휴지통 버전 열 보정 완료. 문서를 새로 열어 내용을 확인한 뒤 다시 시도하세요.');
		} else console.log('휴지통 버전 열 정상. 변경하지 않았습니다.');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.once('uncaughtException', () => {
		writeSync(2, '휴지통 스키마 점검이 중단되었습니다. DB 연결과 스키마 상태를 확인해 주세요.\n');
		process.exit(1);
	});
	main().catch((cause) => {
		console.error(
			cause instanceof TrashSchemaError
				? cause.message
				: '휴지통 스키마 보정 결과를 확인하지 못했습니다. DB 연결·권한·잠금 상태를 확인하고 --check로 다시 점검하세요.'
		);
		process.exitCode = 1;
	});
}
