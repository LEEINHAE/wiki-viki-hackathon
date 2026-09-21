export const recoveryKinds = [
	'new_document',
	'document',
	'draft',
	'proposal',
	'discussion',
	'document_merge'
];
const inputNames = new Set([
	'id',
	'version',
	'title',
	'content',
	'aliases',
	'tags',
	'field',
	'description',
	'sourceName',
	'editor',
	'summary',
	'mergeId',
	'discussionId',
	'body',
	'intent',
	'anchor',
	'targetSlug',
	'sourceVersion',
	'targetVersion',
	'note',
	'mergeContent'
]);
export function recoveryValues(values) {
	return Object.fromEntries(
		Object.entries(values || {}).filter(
			([name, value]) => inputNames.has(name) && typeof value === 'string'
		)
	);
}
export function validRecoveryScope(kind, resources) {
	return (
		recoveryKinds.includes(kind) &&
		Array.isArray(resources) &&
		resources.length === (kind === 'new_document' ? 0 : kind === 'document_merge' ? 2 : 1) &&
		resources.every(
			(resource) =>
				resource?.type === (kind === 'draft' ? 'draft' : 'document') &&
				/^[1-9]\d{0,18}$/.test(String(resource.id))
		)
	);
}
