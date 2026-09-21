import { json } from '@sveltejs/kit';
import { searchDocuments } from '$lib/server/search.js';
import { answerQuestion } from '$lib/server/openai.js';
export async function POST({ request }) {
	let input;
	try {
		input = await request.json();
	} catch {
		return json({ message: '올바른 검색어를 입력해 주세요.' }, { status: 400 });
	}
	if (typeof input?.q !== 'string' || !input.q.trim() || input.q.length > 200)
		return json({ message: '검색어는 1~200자로 입력해 주세요.' }, { status: 400 });
	try {
		const documents = await searchDocuments(input.q.trim(), 6);
		return json(await answerQuestion(input.q.trim(), documents, request.signal));
	} catch (cause) {
		if (cause.status === 429)
			return json(
				{
					status: 'unavailable',
					message:
						'AI 서비스의 이용 한도에 도달했습니다. 관리자에게 확인을 요청하거나 아래 원문을 확인해 주세요.'
				},
				{ status: 503 }
			);
		return json(
			{
				status: 'unavailable',
				message: 'AI 설명을 불러오지 못했습니다. 검색된 원문은 계속 확인할 수 있습니다.'
			},
			{ status: 503 }
		);
	}
}
