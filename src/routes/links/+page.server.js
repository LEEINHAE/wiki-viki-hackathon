import { inspectDocumentLinks } from '$lib/server/document-links.js';

export async function load({ url, setHeaders }) {
	setHeaders?.({ 'cache-control': 'no-store' });
	try {
		return { report: await inspectDocumentLinks(url), databaseError: false };
	} catch {
		return { report: null, databaseError: true };
	}
}
