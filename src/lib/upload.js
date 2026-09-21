export const uploadAccept = '.docx,.pdf,.xlsx,.pptx';
export const uploadFormatMessage =
	'DOCX, 텍스트 기반 PDF, Excel(.xlsx), PowerPoint(.pptx) 파일을 선택해 주세요. 구형 .xls·.ppt는 .xlsx·.pptx로 저장한 뒤 올려 주세요.';
export const supportsUpload = (name) => /\.(docx|pdf|xlsx|pptx)$/i.test(name || '');

export const uploadUnconfirmedMessage =
	'초안 생성 결과를 확인하지 못했습니다. 초안 검토 목록을 먼저 확인한 뒤 다시 시도해 주세요.';

export async function readUploadResponse(response) {
	// Proxies can return HTML or an empty body, including after the server has saved drafts.
	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		const fallback =
			response.status === 413
				? '업로드 요청이 서버의 용량 제한을 넘었습니다. 더 작은 파일로 다시 시도해 주세요.'
				: uploadUnconfirmedMessage;
		throw new Error(
			typeof payload?.message === 'string' && payload.message.trim() ? payload.message : fallback
		);
	}
	if (
		!Array.isArray(payload?.drafts) ||
		payload.drafts.length < 1 ||
		payload.drafts.length > maxDraftDocuments ||
		payload.count !== payload.drafts.length ||
		typeof payload.aiGenerated !== 'boolean' ||
		typeof payload.semanticSkipped !== 'boolean' ||
		payload.drafts.some(
			(draft) =>
				!draft ||
				!/^\d+$/.test(String(draft.id ?? '')) ||
				typeof draft.title !== 'string' ||
				!draft.title.trim() ||
				!['review', 'blocked'].includes(draft.status) ||
				!Number.isInteger(draft.linkCount) ||
				draft.linkCount < 0
		)
	) {
		throw new Error(uploadUnconfirmedMessage);
	}
	return payload;
}
import { maxDraftDocuments } from './knowledge.js';
