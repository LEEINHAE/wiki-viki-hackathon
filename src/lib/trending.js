import { regexGovernance } from './content-policy.js';

export function trendingQuery(value) {
	if (typeof value !== 'string') return null;
	if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
	const query = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
	if (
		query.length < 2 ||
		query.length > 80 ||
		!/[\p{L}\p{N}]/u.test(query) ||
		!regexGovernance(query).passed
	)
		return null;
	return { query, key: query.toLocaleLowerCase('ko-KR') };
}

export function recordSearch(query) {
	if (!trendingQuery(query)) return;
	// Only deliberate submissions/selections count, never autocomplete keystrokes.
	fetch('/api/trending', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query }),
		keepalive: true
	}).catch(() => {});
}
