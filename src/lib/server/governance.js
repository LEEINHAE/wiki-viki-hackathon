const rules = [
	['기밀 또는 대외비 자료', /\bconfidential\b|대외비|기밀/iu],
	[
		'인사 또는 급여 정보',
		/\b(?:salary|payroll|compensation|human resources)\b|급여|연봉|인사정보/iu
	],
	[
		'직원 식별 정보',
		/\b(?:employee|staff)\s*(?:id|no\.?|number)\s*[:#-]?\s*[a-z0-9-]{3,}\b|사번\s*[:#-]?\s*[a-z0-9-]+/iu
	],
	// 앞뒤에 숫자가 더 붙어있으면(=긴 숫자열의 일부) 매칭 제외
	[
		'개인 연락처',
		/(?<!\d)(?:\+?82[- .]?)?0?1[016789](?:[- .]?\d{3,4}){2}(?!\d)|(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}(?![\w.-])/iu
	],
	['주민등록번호', /(?<!\d)\d{6}-[1-4]\d{6}(?!\d)/u]
];

export function regexGovernance(text) {
	const reasons = rules.filter(([, rule]) => rule.test(text)).map(([reason]) => reason);
	return { passed: reasons.length === 0, reasons };
}

export function validHandle(value) {
	return /^(?:Editor-\d{2,}|Operator-[A-Z][A-Z0-9-]*)$/.test(value || '');
}
