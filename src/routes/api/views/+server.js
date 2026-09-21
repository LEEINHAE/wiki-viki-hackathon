import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db.js';

export async function POST({ request }) {
	const { slug } = await request.json();
	if (typeof slug !== 'string' || slug.length > 300) return json({}, { status: 400 });
	await db()`UPDATE documents SET views=views+1 WHERE slug=${slug}`;
	return json({ ok: true });
}
