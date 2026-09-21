import { createRecoveryStore } from './recovery-store.js';

export const draftFields = [
	'id',
	'version',
	'title',
	'content',
	'aliases',
	'editor',
	'proposalId',
	'target',
	'finalContent',
	'mergeEditor',
	'sourceName'
];
export const validRecoveryDraftId = (id) =>
	typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
export const draftRecoveryStore = createRecoveryStore({
	prefix: 'wiki-viki:draft-recovery:v1:',
	fields: draftFields,
	inputFields: [
		'title',
		'content',
		'aliases',
		'editor',
		'finalContent',
		'mergeEditor',
		'sourceName'
	],
	rejectedFields: ['title', 'content', 'aliases', 'finalContent', 'sourceName'],
	inspectScope: false,
	validScope: validRecoveryDraftId,
	matchesScope: (scope, values) => values.id === scope
});

export function draftValues(data, form = null, scope = '') {
	const draft =
		data.selected && (!form?.id || String(form.id) === String(data.selected.id))
			? data.selected
			: null;
	const proposal = draft && data.proposal && !data.proposal.invalid ? data.proposal : null;
	const matches = (data.targets || []).filter((t) => t.matched);
	const target = proposal
		? `${proposal.targetId}:${proposal.targetFingerprint}`
		: matches.length === 1
			? `${matches[0].id}:${matches[0].version}`
			: '';
	return {
		id: String(form?.id ?? draft?.id ?? scope),
		version: form?.version ?? draft?.version ?? '',
		title: form?.title ?? draft?.title ?? '',
		content: form?.content ?? draft?.content ?? '',
		aliases: form?.aliases ?? (Array.isArray(draft?.aliases) ? draft.aliases.join('\n') : ''),
		editor: form?.editor ?? draft?.editor_handle ?? '',
		proposalId: String(form?.proposalId ?? draft?.governance?.merge?.id ?? ''),
		target: form?.target ?? target,
		finalContent: form?.finalContent ?? proposal?.content ?? '',
		mergeEditor: form?.mergeEditor ?? draft?.editor_handle ?? '',
		sourceName: draft?.source_name ?? ''
	};
}
export const semanticRejected = (governance) =>
	governance?.semantic?.passed === false &&
	!governance.semantic.skipped &&
	!governance.semantic.unavailable;
export function draftInputPending(values, draft) {
	const saved = draftValues({ selected: draft });
	return ['title', 'content', 'aliases', 'editor'].some(
		(field) => values[field].replace(/\r\n/g, '\n') !== saved[field].replace(/\r\n/g, '\n')
	);
}
