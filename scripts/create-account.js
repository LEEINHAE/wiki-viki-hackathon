import { openDatabase } from './database.js';
import { hashPassword } from '../src/lib/server/passwords.js';
import { validHandle } from '../src/lib/content-policy.js';
import { roles } from '../src/lib/auth-policy.js';
const [handle, role = 'reader'] = process.argv.slice(2);
if (!validHandle(handle) || !roles.includes(role) || !process.env.DATABASE_URL)
	throw Error('계정 이름, 역할, DATABASE_URL을 확인하세요.');
// Read via a hidden shell prompt; never pass a password as a CLI argument.
const hash = await hashPassword(process.env.WIKI_ACCOUNT_PASSWORD);
delete process.env.WIKI_ACCOUNT_PASSWORD;
const sql = openDatabase();
try {
	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(21470921,3)`;
		const [row] =
			await tx`INSERT INTO wv_users(handle,role,password_hash) VALUES(${handle},${role},${hash}) RETURNING id`;
		await tx`INSERT INTO wv_account_events(subject_id,action,details) VALUES(${row.id},'created',${tx.json({ role, method: 'server_cli' })})`;
	});
	console.log('계정을 생성했습니다.');
} catch {
	console.error('계정을 생성하지 못했습니다. 마이그레이션과 중복 계정을 확인하세요.');
	process.exitCode = 1;
} finally {
	await sql.end();
}
