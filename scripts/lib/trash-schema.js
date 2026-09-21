export class TrashSchemaError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TrashSchemaError';
	}
}

// Repair only the known legacy schema gap. Do not adopt or rewrite a different
// migration ledger, recreate tables, or change existing deletion metadata.
export async function repairTrashSchema({ sql, apply = false, lockTimeoutMs = 10000 }) {
	if (typeof apply !== 'boolean' || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0)
		throw new TrashSchemaError('휴지통 스키마 보정 옵션을 확인해 주세요.');
	return sql.begin(apply ? 'isolation level read committed' : 'read only', async (tx) => {
		await tx`SELECT set_config('lock_timeout', ${lockTimeoutMs + 'ms'}, true)`;
		await tx`SET LOCAL statement_timeout = '30s'`;
		const [{ schema }] = await tx`SELECT current_schema() AS schema`;
		if (!schema) throw new TrashSchemaError('대상 DB 스키마를 찾지 못했습니다.');
		const table = tx(`${schema}.documents`);
		if (apply) {
			// Same advisory lock as the migration runner; serialize concurrent repairs.
			await tx`SELECT pg_advisory_xact_lock(1465273673, hashtext(${schema}))`;
			await tx`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`;
		}
		const columns = await tx`SELECT column_name, data_type, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = ${schema} AND table_name = 'documents'`;
		const column = (name) => columns.find((row) => row.column_name === name);
		if (
			column('deleted_at')?.data_type !== 'timestamp with time zone' ||
			column('deleted_by')?.data_type !== 'text'
		)
			throw new TrashSchemaError(
				'기존 휴지통 열의 구조가 예상과 다릅니다. 일반 마이그레이션 적용 상태를 먼저 확인해 주세요.'
			);
		const version = column('lifecycle_version');
		if (version) {
			if (
				version.data_type !== 'bigint' ||
				version.is_nullable !== 'NO' ||
				!['0', "'0'::bigint", '0::bigint'].includes(version.column_default)
			)
				throw new TrashSchemaError(
					'기존 휴지통 버전 열의 구조가 예상과 다릅니다. 기존 값을 변경하지 않았습니다.'
				);
			return { status: 'ready' };
		}
		if (!apply) return { status: 'missing-lifecycle-version' };
		await tx`ALTER TABLE ${table}
			ADD COLUMN lifecycle_version BIGINT NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0)`;
		return { status: 'repaired' };
	});
}
