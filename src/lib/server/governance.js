import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { createContentPolicy } from '../content-policy.js';
export { validHandle, ContentBlockedError } from '../content-policy.js';

export const contentPolicy = createContentPolicy(
	dev && env.WIKI_CONTENT_POLICY === 'relaxed' ? 'relaxed' : 'strict'
);
export const { regexGovernance, inspectionLocations, assertSafeForAI, inspectContent } =
	contentPolicy;
