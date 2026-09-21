import { json } from '@sveltejs/kit';
import { uploadOwner } from '$lib/server/upload-jobs.js';
import { db } from '$lib/server/db.js';
import { ContentBlockedError } from '$lib/server/governance.js';
import {
	PART_BYTES,
	boundedBody,
	beginTransfer,
	putTransferPart,
	transferState,
	discardTransfer,
	transferFailure,
	TransferError
} from '$lib/server/upload-buffers.js';

export const config = { maxDuration: 30 };
function publicState(row) {
	return {
		token: row.token,
		name: row.file_name,
		size: row.file_size,
		parts: row.part_count,
		received: row.received,
		expiresAt: row.expires_at,
		partBytes: PART_BYTES
	};
}
async function handle({ request, cookies, url }) {
	try {
		const owner = uploadOwner(cookies, {
			create: request.method === 'POST',
			secure: url.protocol === 'https:'
		});
		await db()`DELETE FROM wv_upload_buffers WHERE expires_at<NOW()`;
		const token = url.searchParams.get('token');
		if (request.method === 'GET' && !token) {
			const rows = owner
				? await db()`SELECT token,file_name,file_size,part_count,expires_at,
				ARRAY(SELECT ordinal FROM wv_upload_parts WHERE buffer_id=b.id ORDER BY ordinal) AS received
				FROM wv_upload_buffers b WHERE owner_hash=${owner} AND expires_at>NOW() ORDER BY created_at DESC LIMIT 3`
				: [];
			return json(rows.map(publicState));
		}
		if (request.method === 'GET') return json(publicState(await transferState(owner, token)));
		if (request.headers.get('content-type')?.split(';')[0] === 'application/octet-stream') {
			const ordinal = url.searchParams.get('part');
			if (!/^\d$/.test(ordinal || '')) throw new TransferError('전송 순서를 확인해 주세요.');
			await putTransferPart(owner, token, Number(ordinal), await boundedBody(request, PART_BYTES));
			return json({ received: Number(ordinal) });
		}
		let input;
		try {
			input = JSON.parse((await boundedBody(request, 4096)).toString());
		} catch (cause) {
			if (cause instanceof TransferError) throw cause;
			throw new TransferError('전송 정보를 확인해 주세요.');
		}
		if (input?.action === 'discard') {
			await discardTransfer(owner, input.token);
			return json({ discarded: true });
		}
		if (!input || typeof input !== 'object') throw new TransferError('전송 정보를 확인해 주세요.');
		return json(publicState(await beginTransfer(owner, input)));
	} catch (cause) {
		const failure =
			cause instanceof ContentBlockedError
				? { status: 400, message: cause.message }
				: transferFailure(cause);
		return json({ message: failure.message }, { status: failure.status });
	}
}
export const GET = handle;
export const POST = handle;
