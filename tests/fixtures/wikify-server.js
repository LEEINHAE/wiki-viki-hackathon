// Isolated server dependencies: never read .env or connect to a real database.
export const env = { OPENAI_API_KEY: 'test-only-key' };
export const database = { calls: 0, drafts: [] };

export function db() {
	database.calls += 1;
	const sql = async (strings, ...values) => {
		if (!strings.join('').includes('INSERT INTO drafts')) return [];
		const draft = {
			id: database.drafts.length + 1,
			title: values[0],
			content: values[2],
			governance: JSON.parse(values[5]),
			status: values[6]
		};
		database.drafts.push(draft);
		return [draft];
	};
	sql.transaction = (queries) => Promise.all(queries(sql));
	return sql;
}
