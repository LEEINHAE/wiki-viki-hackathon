import { json } from '@sveltejs/kit';
import { renderWiki, buildToc } from '$lib/server/wiki.js';

export async function POST({ request }) {
	let content;
	try {
		content = (await request.json()).content;
	} catch {
		return json({ message: '본문을 읽을 수 없습니다.' }, { status: 400 });
	}
	if (typeof content !== 'string' || content.length > 200000)
		return json({ message: '본문은 20만 자 이하여야 합니다.' }, { status: 400 });
	try {
		return json(
			{ html: await renderWiki(content), toc: buildToc(content) },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch {
		return json(
			{ message: '연결 상태를 확인하고 다시 입력해 주세요. 미리보기를 불러오지 못했습니다.' },
			{ status: 503 }
		);
	}
}
