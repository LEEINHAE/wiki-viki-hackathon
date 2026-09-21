export const batchReviewLimit = 8;
export const reviewPageSize = 20;

export const reviewToken = (draft) => `${draft.id}:${draft.version}`;

export function batchReviewReason(draft) {
	if (draft.governance?.merge) return '통합안이 있습니다. 상세 화면에서 통합 내용을 검토해 주세요.';
	if (draft.governance?.semantic?.unavailable)
		return '검사를 완료하지 못했습니다. 수정·통합 화면에서 다시 저장해 주세요.';
	if (draft.status !== 'review' || draft.governance?.passed === false)
		return '확인이 필요한 내용이 있습니다. 수정 후 다시 저장해 주세요.';
	return '';
}

export function reviewListPage(drafts, url) {
	const filter = ['review', 'blocked'].includes(url.searchParams.get('status'))
		? url.searchParams.get('status')
		: 'all';
	const filtered = drafts.filter((draft) => filter === 'all' || draft.status === filter);
	const pages = Math.max(1, Math.ceil(filtered.length / reviewPageSize));
	const requested = Number(url.searchParams.get('page') || 1);
	const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1;
	return {
		filter,
		page,
		pages,
		total: filtered.length,
		items: filtered.slice((page - 1) * reviewPageSize, page * reviewPageSize)
	};
}
