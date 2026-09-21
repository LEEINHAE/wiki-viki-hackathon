import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class MigrationError extends Error {
	constructor(code, message, cause) {
		super(message, { cause });
		this.name = 'MigrationError';
		this.code = code;
	}
}

// Ignore quoted bodies and nested comments when looking for transaction control.
// Migration SQL is reviewed repository code; it must not commit outside the runner.
function assertTransactional(source) {
	let visible = '';
	for (let i = 0; i < source.length;) {
		if (source.startsWith('--', i)) {
			const end = source.slice(i + 2).search(/[\r\n]/);
			i = end < 0 ? source.length : i + 2 + end + 1;
			visible += ' ';
		} else if (source.startsWith('/*', i)) {
			let depth = 1;
			i += 2;
			while (i < source.length && depth) {
				if (source.startsWith('/*', i)) {
					depth++;
					i += 2;
				} else if (source.startsWith('*/', i)) {
					depth--;
					i += 2;
				} else i++;
			}
			if (depth) throw new Error('Unclosed SQL comment');
			visible += ' ';
		} else if (source[i] === "'" || source[i] === '"') {
			const quote = source[i];
			const escapes =
				quote === "'" && /e/i.test(source[i - 1] || '') && !/[\w$]/.test(source[i - 2] || '');
			i++;
			let closed = false;
			while (i < source.length) {
				if (escapes && source[i] === '\\') i += 2;
				else if (source[i] === quote && source[i + 1] === quote) i += 2;
				else if (source[i++] === quote) {
					closed = true;
					break;
				}
			}
			if (!closed) throw new Error('Unclosed SQL quote');
			visible += ' quoted ';
		} else {
			const dollar =
				source[i] === '$' &&
				!/[\w$]/.test(source[i - 1] || '') &&
				source.slice(i).match(/^\$(?:[a-z_][\w]*)?\$/i)?.[0];
			if (dollar) {
				const end = source.indexOf(dollar, i + dollar.length);
				if (end < 0) throw new Error('Unclosed SQL body');
				i = end + dollar.length;
				visible += ' quoted ';
			} else visible += source[i++];
		}
	}
	if (!visible.split(';').some((statement) => statement.trim())) throw new Error('Empty SQL');
	for (const statement of visible.split(';')) {
		if (
			/^\s*(?:BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|END\b|ROLLBACK\b|ABORT\b|PREPARE\s+TRANSACTION\b|SAVEPOINT\b|RELEASE\b|SET\s+(?:(?:LOCAL|SESSION)\s+)?TRANSACTION\b)/i.test(
				statement
			)
		)
			throw new Error('Transaction control is owned by the runner');
	}
}

export async function readMigrations(directory = new URL('../../migrations/', import.meta.url)) {
	const path = directory instanceof URL ? fileURLToPath(directory) : directory;
	try {
		const entries = (await readdir(path, { withFileTypes: true })).filter((entry) =>
			/\.sql$/i.test(entry.name)
		);
		if (!entries.length) throw new Error('No migrations');
		const migrations = await Promise.all(
			entries.map(async (entry) => {
				const match = entry.name.match(/^(\d{3,})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/);
				if (
					!entry.isFile() ||
					!match ||
					BigInt(match[1]) < 1n ||
					BigInt(match[1]) > 9223372036854775807n
				)
					throw new Error('Invalid migration name');
				const bytes = await readFile(join(path, entry.name));
				const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
				assertTransactional(source);
				return {
					version: String(BigInt(match[1])),
					name: entry.name,
					checksum: createHash('sha256').update(bytes).digest('hex'),
					source
				};
			})
		);
		migrations.sort((a, b) => (BigInt(a.version) < BigInt(b.version) ? -1 : 1));
		if (new Set(migrations.map((item) => item.version)).size !== migrations.length)
			throw new Error('Duplicate version');
		return migrations;
	} catch (cause) {
		throw new MigrationError(
			'FILES',
			'마이그레이션 파일을 확인해 주세요. 번호가 중복되지 않는 NNN_name.sql, UTF-8 SQL, 실행기 밖의 트랜잭션 제어 금지가 필요합니다.',
			cause
		);
	}
}

function matches(row, migration) {
	return (
		migration &&
		String(row.version) === migration.version &&
		row.name === migration.name &&
		row.checksum === migration.checksum
	);
}

export async function runMigrations({ sql, directory, lockTimeoutMs = 10000 }) {
	if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0)
		throw new MigrationError('CONFIG', '마이그레이션 잠금 대기 시간을 확인해 주세요.');
	const migrations = await readMigrations(directory);
	let active;
	try {
		return await sql.begin('isolation level read committed', async (tx) => {
			await tx`SELECT set_config('lock_timeout',${lockTimeoutMs + 'ms'},true)`;
			await tx`SET LOCAL standard_conforming_strings = on`;
			const [{ schema }] = await tx`SELECT current_schema() AS schema`;
			if (!schema)
				throw new MigrationError(
					'SCHEMA',
					'마이그레이션 대상 스키마가 없습니다. 연결 설정을 확인해 주세요.'
				);
			await tx`SELECT set_config('search_path',quote_ident(${schema}),true)`;
			// A transaction-scoped lock serializes bootstrap too, before the ledger exists.
			// Locks are local to the database; the second key separates its schemas.
			await tx`SELECT pg_advisory_xact_lock(1465273673,hashtext(${schema}))`;
			const ledger = tx(`${schema}.schema_migrations`);
			await tx`CREATE TABLE IF NOT EXISTS ${ledger} (
				version BIGINT PRIMARY KEY CHECK(version>0), name TEXT NOT NULL UNIQUE,
				checksum TEXT NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
				applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)`;
			await tx`LOCK TABLE ${ledger} IN SHARE ROW EXCLUSIVE MODE`;
			const history =
				await tx`SELECT version::text,name,checksum FROM ${ledger} m ORDER BY m.version`;
			if (history.some((row, index) => !matches(row, migrations[index])))
				throw new MigrationError(
					'HISTORY',
					'적용 이력과 마이그레이션 파일이 다릅니다. 적용된 파일의 삭제·수정·번호 변경이나 과거 번호 삽입을 확인해 주세요.'
				);
			const pending = migrations.slice(history.length);
			for (const migration of pending) {
				active = migration.name;
				await tx`SET LOCAL standard_conforming_strings = on`;
				await tx.unsafe(migration.source);
				const rows = await tx`INSERT INTO ${ledger} (version,name,checksum)
					VALUES (${migration.version},${migration.name},${migration.checksum}) RETURNING version::text,name,checksum`;
				if (rows.length !== 1 || !matches(rows[0], migration))
					throw new MigrationError(
						'RECORD',
						'마이그레이션 적용 이력을 정확히 기록하지 못했습니다. 이력 테이블의 제약조건과 트리거를 확인해 주세요.'
					);
			}
			const recorded =
				await tx`SELECT version::text,name,checksum FROM ${ledger} m ORDER BY m.version`;
			if (
				recorded.length !== migrations.length ||
				recorded.some((row, index) => !matches(row, migrations[index]))
			)
				throw new MigrationError(
					'RECORD',
					'마이그레이션 이력 검증에 실패했습니다. 이번 실행의 DB 변경과 이력을 함께 취소합니다.'
				);

			return { applied: pending.map((migration) => migration.name), skipped: history.length };
		});
	} catch (cause) {
		if (cause instanceof MigrationError) throw cause;
		const code = /^[A-Z0-9]{5}$/.test(cause?.code || '') ? ` (DB 코드 ${cause.code})` : '';
		throw new MigrationError(
			'DATABASE',
			`마이그레이션${active ? ' ' + active : ''} 완료를 확인하지 못했습니다${code}. 적용 이력과 DB 상태를 확인한 뒤 다시 실행해 주세요.`,
			cause
		);
	}
}
