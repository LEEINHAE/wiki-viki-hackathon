import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseSchema } from '../src/lib/database-schema.js';

test('database selection keeps persistent data and disposable fixtures separate', () => {
	assert.equal(databaseSchema({}), 'public');
	assert.equal(databaseSchema({ WIKI_DB_SCHEMA: 'wiki_development' }), 'wiki_development');
	assert.equal(
		databaseSchema({ WIKI_DB_SCHEMA: 'wiki_development', WIKI_TEST_SCHEMA: 'wiki_test_auth_123' }),
		'wiki_test_auth_123'
	);
	assert.throws(() => databaseSchema({ WIKI_DB_SCHEMA: 'wiki_test_auth_123' }));
	assert.throws(() =>
		databaseSchema({ NODE_ENV: 'production', WIKI_TEST_SCHEMA: 'wiki_test_auth_123' })
	);
	assert.equal(
		databaseSchema({ NODE_ENV: 'production', WIKI_DB_SCHEMA: 'wiki_live' }),
		'wiki_live'
	);
});

test('schema settings cannot add fallback namespaces or select system schemas', () => {
	for (const name of [
		'public,pg_catalog',
		'"public"',
		'pg_catalog',
		'pg_temp',
		'x;drop',
		'a'.repeat(64)
	]) {
		assert.throws(() => databaseSchema({ WIKI_DB_SCHEMA: name }), name);
		assert.throws(() => databaseSchema({ WIKI_TEST_SCHEMA: name }), name);
	}
});
