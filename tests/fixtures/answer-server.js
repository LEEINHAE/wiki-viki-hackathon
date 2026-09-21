// In-memory query boundary only; never connects to a database or reads .env.
export const env = { OPENAI_API_KEY: 'test-only-key' };
export const database = { calls: [], documents: [], fail: false };

export function db() {
	return async (strings, ...values) => {
		const query = strings.join('');
		database.calls.push({ query, values });
		if (database.fail) throw new Error('Synthetic DB unavailable');
		if (!query.trimStart().startsWith('SELECT')) throw new Error('Unexpected database mutation');
		if (query.includes('COUNT(*)::int AS count')) return [{ count: 0 }];
		if (query.includes('SELECT d.*, CASE')) return database.documents.slice(0, values.at(-1));
		if (query.includes('FROM documents ORDER BY')) return database.documents;
		return [];
	};
}
