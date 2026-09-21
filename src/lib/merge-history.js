import { validMergeResult } from './merge.js';

export const mergeHistoryPrefix = '[AI 통합 · 새 초안 우선]\n';
export const normalizeMergeText = (text) => text.replace(/\r\n/g, '\n');

export function mergeHistory(draft, proposal, content) {
	return (
		mergeHistoryPrefix +
		JSON.stringify({
			schemaVersion: 1,
			proposalId: proposal.id,
			draftId: String(draft.id),
			draftTitle: draft.title,
			sourceName: draft.source_name,
			summary: proposal.summary,
			conflicts: proposal.conflicts,
			manuallyEdited: normalizeMergeText(content) !== normalizeMergeText(proposal.content)
		})
	);
}

// An ordinary or malformed historical summary remains visible as its original text.
export function parseMergeHistory(summary) {
	if (typeof summary !== 'string' || !summary.startsWith(mergeHistoryPrefix)) return null;
	try {
		const value = JSON.parse(summary.slice(mergeHistoryPrefix.length));
		if (
			value?.schemaVersion !== 1 ||
			typeof value.proposalId !== 'string' ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
				value.proposalId
			) ||
			typeof value.draftId !== 'string' ||
			!/^[1-9]\d{0,18}$/.test(value.draftId) ||
			BigInt(value.draftId) > 9223372036854775807n ||
			typeof value.draftTitle !== 'string' ||
			(value.sourceName !== null && typeof value.sourceName !== 'string') ||
			typeof value.manuallyEdited !== 'boolean' ||
			!validMergeResult({ content: 'history', summary: value.summary, conflicts: value.conflicts })
		)
			return null;
		return value;
	} catch {
		return null;
	}
}

// Inspect the same human-authored/generated text that history displays. Machine IDs
// stay in the stored history, but their random digits are not contact information.
export function mergeHistoryInspection(summary) {
	const record = parseMergeHistory(summary);
	if (!record) throw new Error('Invalid merge history');
	return [
		'AI 통합 · 새 초안 우선',
		`초안 제목: ${record.draftTitle}`,
		`업로드 자료: ${record.sourceName || '직접 작성'}`,
		`통합 요약: ${record.summary}`,
		...record.conflicts.flatMap(({ topic, previous, incoming }) => [
			`상충 주제: ${topic}`,
			`기존 내용: ${previous}`,
			`새 초안 내용: ${incoming}`
		])
	].join('\n');
}
