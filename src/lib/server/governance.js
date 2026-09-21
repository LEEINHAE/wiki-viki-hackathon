import { regexGovernance } from '../content-guard.js';
export { regexGovernance } from '../content-guard.js';

export class ContentBlockedError extends Error {
	constructor(
		message = '콘텐츠 보호 검사로 초안 생성을 중단했습니다. 파일명과 원문의 주민등록번호·비밀번호·인증 키를 제거한 뒤 다시 시도해 주세요.'
	) {
		super(message);
		this.name = 'ContentBlockedError';
	}
}

export function assertSafeForAI(...fields) {
	const result = regexGovernance(fields.join('\n'));
	if (!result.passed) throw new ContentBlockedError();
	return result;
}

export function validHandle(value) {
	return /^(?:Editor-\d{2,}|Operator-[A-Z][A-Z0-9-]*)$/.test(value || '');
}
