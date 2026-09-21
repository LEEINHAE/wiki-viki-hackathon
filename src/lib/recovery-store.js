import { regexGovernance } from './content-guard.js';

export const recoveryLifetime = 24 * 60 * 60 * 1000;
const validId = (id) =>
	typeof id === 'string' &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const normalize = (value) => value.replace(/\r\n/g, '\n');

// Keep namespaces and schemas explicit so adding draft recovery cannot rewrite existing edit copies.
export function createRecoveryStore({
	prefix,
	fields,
	inputFields,
	rejectedFields = inputFields,
	inspectScope = true,
	validScope = (scope) => typeof scope === 'string' && !!scope,
	matchesScope = () => true
}) {
	const copyValues = (values) => Object.fromEntries(fields.map((field) => [field, values[field]]));
	const sameValues = (a, b) => fields.every((field) => normalize(a[field]) === normalize(b[field]));
	const safe = (scope, values) =>
		regexGovernance(
			[...(inspectScope ? [scope] : []), ...inputFields.map((field) => values[field])].join('\n')
		).passed;
	function key(scope, id) {
		if (!validScope(scope) || !validId(id)) throw new Error('Invalid recovery identity');
		return prefix + encodeURIComponent(scope) + ':' + id;
	}
	const validValues = (scope, values) =>
		!!values &&
		fields.every((field) => typeof values[field] === 'string') &&
		matchesScope(scope, values);
	function validRecord(record, storageKey) {
		return (
			record?.schemaVersion === 1 &&
			validScope(record.scope) &&
			validId(record.id) &&
			key(record.scope, record.id) === storageKey &&
			Number.isSafeInteger(record.savedAt) &&
			record.expiresAt === record.savedAt + recoveryLifetime &&
			validValues(record.scope, record.values)
		);
	}
	function read(storage, scope, now = Date.now()) {
		const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)),
			copies = [];
		let invalid = false,
			purged = false;
		for (const storageKey of keys) {
			if (!storageKey?.startsWith(prefix)) continue;
			let record;
			const raw = storage.getItem(storageKey);
			try {
				record = JSON.parse(raw);
			} catch {
				invalid = true;
				continue;
			}
			if (!validRecord(record, storageKey)) {
				invalid = true;
				continue;
			}
			if (now >= record.expiresAt || !safe(record.scope, record.values)) {
				storage.removeItem(storageKey);
				purged = true;
				continue;
			}
			if (record.scope === scope) copies.push(record);
		}
		return {
			copies: copies.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id)),
			invalid,
			purged
		};
	}
	function write(storage, scope, id, values, now = Date.now()) {
		const storageKey = key(scope, id);
		if (!validValues(scope, values) || !safe(scope, values)) {
			storage.removeItem(storageKey);
			return null;
		}
		const record = {
			schemaVersion: 1,
			scope,
			id,
			savedAt: now,
			expiresAt: now + recoveryLifetime,
			values: copyValues(values)
		};
		storage.setItem(storageKey, JSON.stringify(record));
		return record;
	}
	function remove(storage, scope, id) {
		storage.removeItem(key(scope, id));
	}
	function removeRejected(storage, scope, values) {
		for (const record of read(storage, scope).copies)
			if (
				rejectedFields.every(
					(field) => normalize(record.values[field]).trim() === normalize(values[field]).trim()
				)
			)
				remove(storage, scope, record.id);
	}
	return { prefix, copyValues, sameValues, safe, key, read, write, remove, removeRejected };
}
