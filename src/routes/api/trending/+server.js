import { json } from '@sveltejs/kit';
import { recordTrending, searchTrending } from '$lib/server/trending.js';
const reply = (value, status = 200) =>
	json(value, { status, headers: { 'cache-control': 'private, no-store' } });
export async function GET() {
	try {
		return reply(await searchTrending());
	} catch {
		return reply({ message: '실시간 검색어를 불러오지 못했습니다.' }, 503);
	}
}
export async function POST(event) {
	try {
		const raw = await event.request.text();
		if (raw.length > 1000) return reply({ recorded: false }, 400);
		let input;
		try {
			input = JSON.parse(raw);
		} catch {
			return reply({ recorded: false }, 400);
		}
		return reply({ recorded: await recordTrending(event, input?.query) });
	} catch {
		return reply({ recorded: false }, 503);
	}
}
