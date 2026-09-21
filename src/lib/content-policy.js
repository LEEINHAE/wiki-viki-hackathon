const reviewRules = [
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
	]
];
const criticalRules = [
	['주민등록번호', /(?<!\d)\d{6}-[1-4]\d{6}(?!\d)/u],
	[
		'인증 키 또는 비밀 키',
		/\b(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu
	],
	[
		'비밀번호 또는 접근 토큰',
		/(?:password|passwd|api[_ -]?key|access[_ -]?token|비밀번호)\s*[:=]\s*["']?(?!(?:example|sample|placeholder|\*{3,}|<|\$\{))[^\s,;"']{8,}/iu
	]
];
const rules = [...criticalRules, ...reviewRules];

export function regexGovernance(text, { mode = 'strict' } = {}) {
	const relaxed = mode === 'relaxed';
	const reasons = (relaxed ? criticalRules : rules)
		.filter(([, rule]) => rule.test(text))
		.map(([reason]) => reason);
	const warnings = relaxed
		? reviewRules.filter(([, rule]) => rule.test(text)).map(([reason]) => reason)
		: [];
	return { passed: reasons.length === 0, reasons, warnings };
}

// Positions are measured in the supplied text. Never infer a location for a
// semantic-only finding, or store the sensitive matched value in inspection data.
export function inspectionLocations(text, { mode = 'strict' } = {}) {
	const findings = [];
	for (const [reason, rule] of rules) {
		for (const match of String(text).matchAll(new RegExp(rule.source, rule.flags + 'g'))) {
			findings.push({
				reason,
				severity:
					mode === 'relaxed' && reviewRules.some(([label]) => label === reason)
						? 'review'
						: 'blocked',
				line: text.slice(0, match.index).split('\n').length,
				start: match.index,
				length: match[0].length
			});
			if (findings.length >= 50) return findings;
		}
	}
	return findings.sort((a, b) => a.start - b.start);
}

export function validHandle(value) {
	return /^(?:Editor-\d{2,}|Operator-(?:\d{2,}|[A-Z][A-Z0-9-]*))$/.test(value || '');
}

export class ContentBlockedError extends Error {
	constructor(reasons) {
		super(
			`콘텐츠 보호 검사로 차단되었습니다: ${reasons.join(', ')}. 해당 내용을 제거한 뒤 다시 시도해 주세요.`
		);
		this.name = 'ContentBlockedError';
		this.reasons = reasons;
	}
}

// This local gate is required before EVERY external AI call, including semantic inspection.
export function assertSafeForAI(...values) {
	return assertInput(values, 'strict');
}
function assertInput(values, mode) {
	const result = regexGovernance(values.join('\n'), { mode });
	if (!result.passed) throw new ContentBlockedError(result.reasons);
	return result;
}

export async function inspectContent(values, semanticCheck, { mode = 'strict' } = {}) {
	const text = Array.isArray(values) ? values.join('\n') : String(values);
	const regex = regexGovernance(text, { mode });
	const semantic =
		regex.passed && semanticCheck && mode !== 'relaxed'
			? await semanticCheck(text)
			: {
					passed: null,
					reasons: [],
					skipped: true,
					reason: !regex.passed
						? 'blocked_locally'
						: mode === 'relaxed'
							? 'relaxed_policy'
							: 'manual'
				};
	return {
		policy: mode,
		warnings: regex.warnings,
		passed: regex.passed && (semantic.skipped || semantic.passed === true),
		regex,
		semantic
	};
}

export function createContentPolicy(mode = 'strict') {
	mode = mode === 'relaxed' ? 'relaxed' : 'strict';
	return {
		mode,
		regexGovernance: (text) => regexGovernance(text, { mode }),
		inspectionLocations: (text) => inspectionLocations(text, { mode }),
		assertSafeForAI: (...values) => assertInput(values, mode),
		inspectContent: (values, semanticCheck) => inspectContent(values, semanticCheck, { mode })
	};
}
