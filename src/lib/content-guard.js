// Ordinary internal material (including names, contacts, HR and confidentiality labels) is allowed.
// Keep the same narrow policy at upload, AI, publication, seed and recovery boundaries.
const rules = [
	['주민등록번호', /(?<!\d)\d{6}-[1-4]\d{6}(?!\d)/u],
	[
		'비공개 인증 키',
		/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s+[a-z0-9+/=\s]{32,}-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/iu
	]
];

const isPlaceholder = (value) =>
	/^(?:your[_-]|example(?:[_-]|$)|sample(?:[_-]|$)|dummy(?:[_-]|$)|replace[_-]|process\.env\.|os\.environ\b)/iu.test(
		value
	) || /^(?:password|changeme|required|string|\*+|x{8,}|0{8,})$/iu.test(value);

function hasCredentialValue(text) {
	const assignments =
		/(?:\b(?:password|passwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|aws_secret_access_key)\b|비밀번호|인증[_ ]?키)\s*[:=]\s*["']?([a-z0-9_!@#$%^&*+=./:-]{8,})/giu;
	for (const [, value] of text.matchAll(assignments)) {
		// Documentation placeholders and environment references are not exposed credentials.
		if (isPlaceholder(value)) continue;
		// Bare configuration words are ambiguous; only mixed credential-like values block locally.
		if (!/[a-z]/iu.test(value) || !/[0-9!@#$%^&*+=]/u.test(value)) continue;
		return true;
	}
	return false;
}

export function regexGovernance(text) {
	text = String(text ?? '');
	const reasons = rules.filter(([, rule]) => rule.test(text)).map(([reason]) => reason);
	const keys = text.matchAll(
		/\b(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/giu
	);
	if (
		[...keys].some(
			([key]) =>
				!isPlaceholder(key.replace(/^(?:sk-(?:proj-|svcacct-)?|gh[pousr]_|github_pat_)/iu, ''))
		)
	)
		reasons.push('인증 키');
	if (hasCredentialValue(text)) reasons.push('비밀번호 또는 인증 정보');
	return { passed: reasons.length === 0, reasons };
}
