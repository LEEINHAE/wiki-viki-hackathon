export const templates = {
	term: '## 개요\n\n[용어의 뜻과 사용 맥락]\n\n## 주요 내용\n\n- [확인된 사실]\n\n## 관련 용어\n\n[[관련 문서]]\n\n## 출처\n\n[자료명과 확인 위치]',
	procedure:
		'## 목적과 적용 범위\n\n[이 절차를 사용하는 상황]\n\n## 사전 확인\n\n- [필요한 조건]\n\n## 수행 절차\n\n1. [첫 단계]\n2. [다음 단계]\n\n## 예외와 확인 사항\n\n[검토 필요]\n\n## 출처\n\n[승인된 기준 문서]',
	faq: '## 자주 묻는 질문\n\n### 질문 1\n\n[확인된 근거를 바탕으로 답변]\n\n### 질문 2\n\n[답변과 관련 문서]\n\n## 출처\n\n[자료명과 확인 위치]'
};
export function insertMarkup(value, start, end, before, after = '', placeholder = '내용') {
	const selected = value.slice(start, end) || placeholder;
	return {
		value: value.slice(0, start) + before + selected + after + value.slice(end),
		start: start + before.length,
		end: start + before.length + selected.length
	};
}
