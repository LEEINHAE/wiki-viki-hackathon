import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { searchDocuments } from './search.js';
import { searchOptions } from '../search.js';
import { trendingQuery } from '../trending.js';

export async function recordTrending(event, value) {
	const term = trendingQuery(value);
	if (!term) return false;
	const { results } = await searchDocuments({
		...searchOptions(new URLSearchParams({ q: term.query })),
		limit: 1,
		compact: true
	});
	if (!results.length) return false;
	let visitor = event.locals.user
		? `account:${event.locals.user.id}`
		: event.cookies.get('wv_search_visitor');
	if (!visitor || (!event.locals.user && !/^[a-f0-9-]{36}$/.test(visitor))) {
		visitor = randomUUID();
		event.cookies.set('wv_search_visitor', visitor, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: 3600
		});
	}
	const hash = createHash('sha256').update(visitor).digest('hex');
	const [row] =
		await db()`SELECT wv_record_search_v1(${JSON.stringify({ ...term, visitor: hash, documentId: results[0].id })}::jsonb) AS recorded`;
	return row.recorded;
}

export async function searchTrending() {
	const sql = db();
	const [, rows] = await sql.transaction([
		sql`DELETE FROM wv_search_events WHERE created_at<NOW()-interval '1 hour'`,
		sql`SELECT * FROM wv_search_trending_v1()`
	]);
	return {
		items: rows.map((row, index) => ({
			rank: index + 1,
			query: row.query,
			count: Number(row.count)
		})),
		windowMinutes: 60,
		updatedAt: new Date().toISOString()
	};
}
