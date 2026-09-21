// Synthetic credentials only. Each value is already blocked by the shared local
// policy, but JSON escaping used to hide it from the topic-plan inspection.
export const blockedTopicCases = [
	{ name: 'quoted credential', value: 'api_key="NotARealSecret42!"' },
	{ name: 'line break', value: 'password:\nNotARealSecret42!' },
	{ name: 'Windows line break', value: 'password:\r\nNotARealSecret42!' },
	{ name: 'tab separator', value: 'access_token:\tNotARealSecret42!' },
	{
		name: 'multiline private key',
		value: '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n-----END PRIVATE KEY-----'
	}
];
