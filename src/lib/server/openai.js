import { env } from '$env/dynamic/private';
import { createAI } from './openai-core.js';
import { contentPolicy } from './governance.js';
export const {
	structureDocument,
	structureDocuments,
	semanticGovernance,
	mergeDocuments,
	explainSearch,
	aiErrorMessage
} = createAI(env, { policy: contentPolicy });
