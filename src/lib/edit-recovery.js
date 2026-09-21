import { createRecoveryStore } from './recovery-store.js';
export { recoveryLifetime } from './recovery-store.js';
export const recoveryPrefix = 'wiki-viki:edit-recovery:v1:';
export const editFields = [
	'title',
	'content',
	'aliases',
	'editor',
	'summary',
	'version',
	'documentId',
	'aliasesFormat'
];

export function editValues(data, form = null) {
	return {
		title:
			form?.title ??
			data.document?.title ??
			data.initialTitle ??
			decodeURIComponent(data.slug).replaceAll('-', ' '),
		content:
			form?.content ??
			data.document?.content ??
			'# 개요\n\n이곳에 문서 내용을 작성하세요. [[문서 이름]] 형식으로 다른 문서를 연결할 수 있습니다.',
		aliases: form?.aliases ?? data.aliases ?? '',
		editor: form?.editor ?? 'Editor-01',
		summary: form?.summary ?? '',
		version: form?.version ?? data.version ?? '',
		documentId: String(form?.documentId ?? data.document?.id ?? ''),
		aliasesFormat: form?.aliasesFormat ?? 'lines'
	};
}

export const editRecoveryStore = createRecoveryStore({
	prefix: recoveryPrefix,
	fields: editFields,
	inputFields: ['title', 'content', 'aliases', 'editor', 'summary'],
	rejectedFields: ['title', 'content', 'aliases', 'summary']
});
export const {
	copyValues: copyEditValues,
	sameValues: sameEditValues,
	safe: recoverySafe,
	key: recoveryKey,
	read: readRecoveries,
	write: writeRecovery,
	remove: removeRecovery,
	removeRejected: removeRejectedRecoveries
} = editRecoveryStore;
