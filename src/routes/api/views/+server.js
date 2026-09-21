import { json } from '@sveltejs/kit';
// Older clients receive an explicit retirement response instead of changing data.
export function POST() {
	return json({ message: '조회수는 수집하지 않습니다.' }, { status: 410 });
}
