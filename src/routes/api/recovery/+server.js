import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';
import { regexGovernance } from '$lib/server/governance.js';
import { recoveryValues, validRecoveryScope } from '$lib/recovery-policy.js';
const validKey = (key) =>
	typeof key === 'string' && key.length > 0 && key.length <= 240 && !/[\x00-\x1f]/.test(key);
export async function GET({ locals, url }) {
	if (!locals.user) return json({ message: '로그인이 필요합니다.' }, { status: 401 });
	const key = url.searchParams.get('key');
	if (!validKey(key)) return json({ message: '복구 항목을 확인해 주세요.' }, { status: 400 });
	const sql = db();
	const [, rows] = await sql.transaction([
		sql`DELETE FROM wv_recoveries WHERE expires_at<NOW()`,
		sql`SELECT CASE WHEN wv_recovery_access_v1(kind,resources) THEN input_values END AS values,updated_at::text AS version,extract(epoch FROM expires_at)*1000 AS expires FROM wv_recoveries WHERE user_id=${locals.user.id} AND recovery_key=${key} AND expires_at>NOW()`
	]);
	return json({ backup: rows[0]?.values ? rows[0] : null, version: rows[0]?.version || '' });
}
export async function POST({ locals, request }) {
	if (!locals.user) return json({ message: '로그인이 필요합니다.' }, { status: 401 });
	try {
		const raw = await request.text();
		if (new TextEncoder().encode(raw).length > 1000000)
			return json({ message: '임시 입력이 너무 큽니다.' }, { status: 413 });
		const input = JSON.parse(raw);
		if (!validKey(input.key) || !['save', 'delete'].includes(input.action))
			return json({ message: '복구 항목을 확인해 주세요.' }, { status: 400 });
		const values = recoveryValues(input.values);
		if (input.action === 'save') {
			if (
				!validRecoveryScope(input.kind, input.resources) ||
				Object.values(values).some((v) => v.length > 200000)
			)
				return json({ message: '임시 입력 범위와 길이를 확인해 주세요.' }, { status: 400 });
			if (!regexGovernance(Object.values(values).join('\n')).passed)
				return json(
					{ message: '콘텐츠 검사에 걸린 입력은 임시 보관하지 않습니다.' },
					{ status: 400 }
				);
		}
		const [row] =
			await db()`SELECT wv_save_recovery_v1(${JSON.stringify({ key: input.key, action: input.action, version: input.version || '', kind: input.kind, resources: input.resources, values })}::jsonb) AS result`;
		return json(row.result);
	} catch (cause) {
		const message =
			cause.message === 'recovery_conflict'
				? '다른 화면의 임시 입력이 먼저 저장되었습니다. 새로고침해 복구 항목을 확인해 주세요.'
				: cause.message === 'recovery_limit'
					? '임시 입력은 계정당 20개까지입니다. 사용하지 않는 임시 입력을 삭제해 주세요.'
					: cause.message === 'forbidden'
						? '현재 역할이나 문서 권한으로는 이 입력을 보관할 수 없습니다.'
						: '임시 보관에 실패했습니다. 현재 입력을 유지하고 다시 시도해 주세요.';
		return json(
			{ message },
			{ status: cause instanceof SyntaxError ? 400 : cause.message === 'forbidden' ? 403 : 409 }
		);
	}
}
