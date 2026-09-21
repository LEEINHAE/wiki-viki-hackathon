import { env } from '$env/dynamic/private';
import { contentPolicy } from '$lib/server/governance.js';

export function load({ locals }) {
	return {
		user: locals.user || null,
		demo: !!locals.demo,
		aiAvailable: !!env.OPENAI_API_KEY,
		contentPolicy: contentPolicy.mode
	};
}
