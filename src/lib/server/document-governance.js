import { regexGovernance } from './governance.js';
import { semanticGovernance } from './openai.js';

export async function inspectDocumentContent({ title, content, aliases, summary = '' }) {
	const fields = [
		['title', '제목', title],
		['content', '본문', content],
		['aliases', '별칭', Array.isArray(aliases) ? aliases.join('\n') : ''],
		['summary', '편집 요약', summary]
	];
	const failures = [];
	if (!Array.isArray(aliases) || !aliases.every((alias) => typeof alias === 'string'))
		failures.push({
			field: 'aliases',
			label: '별칭',
			reason: '별칭을 줄마다 하나씩 입력해 주세요.'
		});
	return inspectFields(fields, failures);
}

export function inspectDiscussionContent({ title, body }) {
	return inspectFields([
		['title', '주제', title],
		['body', '의견', body]
	]);
}

async function inspectFields(fields, validationFailures = []) {
	const failures = [
		...fields.flatMap(([field, label, text]) =>
			regexGovernance(text).reasons.map((reason) => ({ field, label, reason }))
		),
		...validationFailures
	];
	const regex = {
		passed: failures.length === 0,
		reasons: failures.map(({ label, reason }) => `${label}: ${reason}`)
	};
	let semantic = { passed: false, reasons: [], skipped: true };
	if (regex.passed) {
		try {
			semantic = await semanticGovernance(fields.map(([, , text]) => text).join('\n'));
		} catch {
			semantic = {
				passed: false,
				reasons: ['AI 의미 검사를 완료하지 못했습니다. 잠시 후 다시 저장해 주세요.'],
				skipped: false,
				unavailable: true
			};
		}
	}
	return { passed: regex.passed && semantic.passed, regex, semantic, fields: failures };
}
