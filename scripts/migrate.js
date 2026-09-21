import postgres from 'postgres';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MigrationError, runMigrations } from './lib/migrations.js';

async function main() {
	if (!process.env.DATABASE_URL) {
		console.error('DATABASE_URL이 필요합니다. 마이그레이션 대상 연결을 설정해 주세요.');
		process.exitCode = 1;
		return;
	}
	const sql = postgres(process.env.DATABASE_URL, {
		max: 1,
		connect_timeout: 10,
		onnotice: () => {}
	});
	try {
		const result = await runMigrations({ sql });
		// Report success only after the complete pending batch and its ledger commit.
		for (const name of result.applied) console.log(`적용 완료: ${name}`);
		console.log(
			`마이그레이션: 적용 ${result.applied.length}개, 기존 적용 유지 ${result.skipped}개.`
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	// A disconnected driver's deferred socket write can throw outside its promise.
	// Fail the CLI immediately: do not continue in that state or expose raw errors.
	// Process exit closes the connection; PostgreSQL owns transaction recovery.
	process.once('uncaughtException', () => {
		writeSync(
			2,
			'마이그레이션 실행이 중단되었습니다. DB 연결과 적용 이력을 확인한 뒤 다시 실행해 주세요.\n'
		);
		process.exit(1);
	});
	main().catch((cause) => {
		console.error(
			cause instanceof MigrationError
				? cause.message
				: '마이그레이션을 완료하지 못했습니다. DB 연결과 적용 이력을 확인해 주세요.'
		);
		process.exitCode = 1;
	});
}
