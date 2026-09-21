import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryValues, validRecoveryScope } from '../src/lib/recovery-policy.js';
test('recovery retains versioned input but never restores approval or authentication controls', () => {
	assert.deepEqual(
		recoveryValues({
			content: '작업 중 본문',
			version: 'exact timestamp',
			reviewed: 'yes',
			password: 'secret',
			userId: '2',
			file: { name: 'x' }
		}),
		{ content: '작업 중 본문', version: 'exact timestamp' }
	);
});
test('recovery scopes include both documents for a merge and reject unbounded or malformed resources', () => {
	assert.ok(
		validRecoveryScope('document_merge', [
			{ type: 'document', id: '1' },
			{ type: 'document', id: '2' }
		])
	);
	assert.ok(!validRecoveryScope('document_merge', [{ type: 'document', id: '1' }]));
	assert.ok(!validRecoveryScope('draft', [{ type: 'document', id: '1' }]));
	assert.ok(!validRecoveryScope('document', [{ type: 'document', id: '1 OR true' }]));
	assert.ok(validRecoveryScope('new_document', []));
});
