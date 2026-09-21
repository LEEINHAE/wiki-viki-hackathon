import { slugify } from './knowledge.js';

export function matchingDocuments(draft, documents, redirects = []) {
	const names = new Set([draft.title, ...(draft.aliases || [])].map(slugify).filter(Boolean));
	const aliasIds = new Set(
		redirects
			.filter((alias) => names.has(alias.alias_slug))
			.map((alias) => String(alias.document_id))
	);
	return documents.filter(
		(doc) => names.has(doc.slug) || names.has(slugify(doc.title)) || aliasIds.has(String(doc.id))
	);
}

export function validateMerge(value) {
	const text = (value, max) =>
		typeof value === 'string' && value.trim().length > 0 && value.length <= max;
	if (
		!value ||
		!text(value.content, 200000) ||
		!text(value.summary, 2000) ||
		!Array.isArray(value.conflicts) ||
		value.conflicts.length > 30 ||
		!value.conflicts.every(
			(conflict) =>
				conflict && ['topic', 'previous', 'incoming'].every((key) => text(conflict[key], 3000))
		)
	)
		throw new Error('Invalid merge response');
	return {
		content: value.content.trim(),
		summary: value.summary.trim(),
		conflicts: value.conflicts
	};
}

export function mergeRevisionSummary(draft, proposal, content = proposal.content) {
	return [
		`[AI 통합 · 새 초안 우선] 초안 ${draft.id}: ${draft.title}`,
		`원본: ${draft.source_name || '직접 작성'}`,
		proposal.summary,
		...(content !== proposal.content
			? [
					'검토자가 AI 통합 본문을 추가 수정했습니다. 최종 적용 내용은 이 버전의 본문과 차이 보기에서 확인할 수 있습니다.'
				]
			: []),
		`상충 내용 ${proposal.conflicts.length}건 — 새 초안 기준으로 통합 후 검토 반영`,
		...proposal.conflicts.map(
			(conflict, index) =>
				`${index + 1}. ${conflict.topic}\n기존: ${conflict.previous}\n새 초안: ${conflict.incoming}`
		)
	].join('\n\n');
}
