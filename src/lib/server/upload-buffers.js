import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { assertSafeForAI } from './governance.js';

export const PART_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 10 * PART_BYTES;
export class TransferError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}
export function validToken(token) {
	return (
		typeof token === 'string' &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token)
	);
}
export async function boundedBody(request, limit) {
	const hardLimit = limit + 65536;
	if (Number(request.headers.get('content-length')) > hardLimit)
		throw new TransferError('전송 크기 제한을 초과했습니다.', 413);
	const reader = request.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const pieces = [];
	let size = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > hardLimit) {
			await reader.cancel();
			throw new TransferError('전송 크기 제한을 초과했습니다.', 413);
		}
		// Drain a small oversized request without retaining it. Canceling a Node
		// request destroys its socket and can reset the following keepalive request.
		if (size <= limit) pieces.push(value);
	}
	if (size > limit) throw new TransferError('전송 크기 제한을 초과했습니다.', 413);
	return Buffer.concat(pieces, size);
}
export async function transferState(owner, token) {
	if (!owner || !validToken(token)) throw new TransferError('파일 전송을 찾을 수 없습니다.', 404);
	const [row] =
		await db()`SELECT b.id,b.token,b.file_name,b.file_size,b.file_hash,b.part_count,b.expires_at,
		ARRAY(SELECT ordinal FROM wv_upload_parts WHERE buffer_id=b.id ORDER BY ordinal) AS received
		FROM wv_upload_buffers b WHERE token=${token}::uuid AND owner_hash=${owner} AND expires_at>NOW()`;
	if (!row)
		throw new TransferError(
			'파일 전송이 만료되었거나 없습니다. 같은 파일을 다시 선택해 주세요.',
			404
		);
	return row;
}
export async function beginTransfer(owner, input) {
	if (
		typeof input.name !== 'string' ||
		!input.name.trim() ||
		input.name.length > 240 ||
		/[\x00-\x1f]/.test(input.name)
	)
		throw new TransferError('파일명을 확인해 주세요.');
	if (!/\.(docx|pdf|xlsx|pptx)$/i.test(input.name))
		throw new TransferError('DOCX, PDF, XLSX, PPTX 파일만 지원합니다.', 415);
	if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_FILE_BYTES)
		throw new TransferError('파일 크기는 1바이트 이상 10MB 이하여야 합니다.', 413);
	if (!/^[a-f0-9]{64}$/.test(input.hash || ''))
		throw new TransferError('파일 확인 값이 올바르지 않습니다.');
	assertSafeForAI(input.name);
	const payload = {
		owner,
		token: randomUUID(),
		name: input.name,
		size: input.size,
		hash: input.hash,
		parts: Math.ceil(input.size / PART_BYTES)
	};
	const [row] =
		await db()`SELECT wv_begin_upload_buffer_v1(${JSON.stringify(payload)}::jsonb) AS buffer`;
	return transferState(owner, row.buffer.token);
}
export async function putTransferPart(owner, token, ordinal, bytes) {
	if (!validToken(token) || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 9)
		throw new TransferError('전송 순서를 확인해 주세요.');
	await db()`SELECT wv_put_upload_part_v1(${token}::uuid,${owner},${ordinal},decode(${bytes.toString('base64')},'base64'))`;
}
export async function discardTransfer(owner, token) {
	if (!validToken(token)) throw new TransferError('파일 전송을 찾을 수 없습니다.', 404);
	await db()`DELETE FROM wv_upload_buffers WHERE owner_hash=${owner} AND token=${token}::uuid`;
}
export async function assembleTransfer(owner, token) {
	const buffer = await transferState(owner, token);
	if (buffer.received.length !== buffer.part_count)
		throw new TransferError(
			'전송되지 않은 파일 구간이 있습니다. 같은 파일로 다시 시도해 주세요.',
			409
		);
	const pieces = [];
	// Fetch each part separately so the database HTTP response stays bounded too.
	for (let index = 0; index < buffer.part_count; index++) {
		const [row] = await db()`SELECT encode(p.bytes,'base64') AS bytes FROM wv_upload_parts p
			JOIN wv_upload_buffers b ON b.id=p.buffer_id WHERE b.token=${token}::uuid AND b.owner_hash=${owner} AND b.expires_at>NOW() AND p.ordinal=${index}`;
		if (!row)
			throw new TransferError('파일 전송이 만료되었습니다. 같은 파일을 다시 선택해 주세요.', 409);
		pieces.push(Buffer.from(row.bytes, 'base64'));
	}
	const bytes = Buffer.concat(pieces);
	await discardTransfer(owner, token);
	if (
		bytes.length !== buffer.file_size ||
		createHash('sha256').update(bytes).digest('hex') !== buffer.file_hash
	)
		throw new TransferError('파일이 전송 중 달라졌습니다. 같은 파일을 다시 선택해 주세요.', 409);
	return new File([bytes], buffer.file_name);
}
export function transferFailure(cause) {
	if (cause instanceof TransferError) return { status: cause.status, message: cause.message };
	const code = String(cause.message || '');
	if (code.includes('upload_buffer_limit'))
		return {
			status: 429,
			message: '전송 중인 파일이 3개 있습니다. 이전 전송을 지우거나 30분 후 다시 시도해 주세요.'
		};
	if (code.includes('upload_part_conflict'))
		return {
			status: 409,
			message: '이미 전송한 구간과 내용이 다릅니다. 전송을 지운 뒤 다시 선택해 주세요.'
		};
	if (code.includes('invalid_part'))
		return { status: 400, message: '파일 구간의 크기 또는 순서가 올바르지 않습니다.' };
	if (code.includes('upload_buffer_missing'))
		return {
			status: 404,
			message: '파일 전송이 만료되었거나 없습니다. 같은 파일을 다시 선택해 주세요.'
		};
	if (code.includes('forbidden')) return { status: 403, message: '파일 전송 권한이 없습니다.' };
	return {
		status: 503,
		message:
			'파일 전송을 완료하지 못했습니다. 같은 파일을 다시 선택하면 남은 구간을 이어서 전송합니다.'
	};
}
