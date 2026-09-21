import test from 'node:test';
import assert from 'node:assert/strict';
import { regexGovernance } from '../src/lib/content-guard.js';

test('ordinary internal documents and incidental personal details are allowed', () => {
	for (const text of [
		'대외비 운영 계획 / confidential.docx / 기밀 유지 안내',
		'인사정보: 홍길동, 인사팀, 사번: demo42, employee id: ABC-123',
		'급여 정산 안내, 연봉 5000만원, salary payroll compensation human resources',
		'담당자 test.user@example.invalid / 010-0000-0000 / +82 10 1234 5678',
		'주민등록번호를 수집하지 않습니다. 비밀번호와 API 키를 공유하지 마세요.',
		'일련번호 9001011000000, 문서 ID 1012345678',
		'password: YOUR_PASSWORD / api_key=YOUR_API_KEY / access_token=<TOKEN>',
		'password: optional / api_key: configured / access_token: generated / client_secret=GENERATE_VIA_DASHBOARD',
		'password="********" / api_key=${API_KEY} / client_secret=process.env.SECRET',
		'sk-proj-YOUR_API_KEY_GOES_HERE / ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
		'-----BEGIN PRIVATE KEY----- 형식 설명'
	])
		assert.deepEqual(regexGovernance(text), { passed: true, reasons: [] }, text);
});

test('only clear identity numbers and exposed credential values block locally', () => {
	for (const text of [
		'주민등록번호 900101-1000000',
		'900101-1000000.docx',
		'password=NotARealSecret42!',
		'비밀번호: NotARealSecret42!',
		'api_key="NotARealSecret42!"',
		'access_token=NotARealSecret42!',
		'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
		'ghp_abcdefghijklmnopqrstuvwxyz123456',
		'-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n-----END PRIVATE KEY-----'
	]) {
		const result = regexGovernance(text);
		assert.equal(result.passed, false, text);
		assert.ok(result.reasons.length > 0);
		assert.ok(result.reasons.every((reason) => !reason.includes('NotARealSecret42')));
	}
});

test('repeated checks have no regex state and do not mistake long numeric identifiers for residents', () => {
	for (let i = 0; i < 3; i++) {
		assert.equal(regexGovernance('1900101-10000000').passed, true);
		assert.equal(regexGovernance('900101-1000000').passed, false);
		assert.equal(regexGovernance('password=NotARealSecret42!').passed, false);
		assert.equal(regexGovernance('대외비 연락처 01012345678').passed, true);
	}
});
