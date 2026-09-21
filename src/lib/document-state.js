import { roleLabels } from './auth-policy.js';
const labels = {
	title: '제목',
	slug: '대표 주소',
	field: '분야',
	description: '요약',
	sourceName: '자료명',
	aliases: '별칭',
	tags: '태그',
	sourceIds: '원문 구간 번호',
	minRole: '최소 읽기 역할',
	archivedAt: '보관 시각',
	deletedAt: '휴지통 시각',
	deletedBy: '삭제 작업자',
	mergedInto: '병합 대상 문서 번호',
	ownerId: '담당자 번호',
	reviewedAt: '마지막 검토 시각',
	reviewedBy: '검토자 번호',
	nextReviewOn: '다음 검토일',
	governance: '콘텐츠 검사·검토 기록'
};
function display(value) {
	if (value === undefined) return '기록 없음';
	if (value === null || value === '') return '미설정';
	if (Array.isArray(value))
		return value.length
			? value.map((v) => (typeof v === 'object' ? `${v.title} (${v.slug})` : String(v))).join(', ')
			: '없음';
	if (typeof value === 'object') return JSON.stringify(value, null, 2);
	return String(value);
}
export function metadataChanges(before, after) {
	return Object.entries(labels)
		.filter(([key]) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
		.map(([key, label]) => ({
			key,
			label,
			before:
				key === 'minRole'
					? roleLabels[before?.[key]] || display(before?.[key])
					: display(before?.[key]),
			after:
				key === 'minRole'
					? roleLabels[after?.[key]] || display(after?.[key])
					: display(after?.[key])
		}));
}
export function hasFullState(state) {
	return state?.stateVersion === 3 && Object.keys(labels).every((key) => Object.hasOwn(state, key));
}
