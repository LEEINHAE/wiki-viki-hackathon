// Keep test fixtures isolated even when .env.local selects persistent data.
export function databaseSchema(env) {
	if (env.WIKI_TEST_SCHEMA) {
		if (env.NODE_ENV === 'production' || !/^wiki_test_[a-z0-9_]{1,53}$/.test(env.WIKI_TEST_SCHEMA))
			throw new Error('Invalid isolated test schema.');
		return env.WIKI_TEST_SCHEMA;
	}
	const schema = env.WIKI_DB_SCHEMA || 'public';
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || /^(pg_|wiki_test_)/.test(schema))
		throw new Error('Invalid persistent database schema.');
	return schema;
}
