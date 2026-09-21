// Prepare historical/permission fixtures through the database, not the removed
// administrator UI. Only disposable test schemas and synthetic accounts qualify.
import assert from 'node:assert/strict';
import { slugify } from '../src/lib/wiki-utils.js';

function asFixtureAdmin(query, operation) {
	return query(async (tx) => {
		const [scope] = await tx`SELECT current_schema() AS name`;
		assert.match(scope.name, /^wiki_test_auth_[0-9]+$/);
		const [actor] =
			await tx`SELECT id FROM wv_users WHERE handle='Operator-24' AND role='admin' AND active`;
		assert.ok(actor, 'Active synthetic administrator is required');
		await tx`SELECT set_config('wv.actor_id',${String(actor.id)},true),set_config('wv.actor_role','admin',true),set_config('wv.operator','0',true)`;
		return operation(tx);
	});
}

export function manageFixtureDocument(query, slug, values) {
	return asFixtureAdmin(query, async (tx) => {
		const [document] = await tx`SELECT id FROM documents WHERE slug=${slug}`;
		assert.ok(document, 'Fixture document must exist');
		const payload = {
			...values,
			id: document.id,
			editor: 'Operator-24',
			inspection: { passed: true }
		};
		if (values.action === 'rename') {
			payload.titleSlug = slugify(values.title);
			await tx`SELECT wv_rename_document_v1(${JSON.stringify(payload)}::jsonb)`;
		} else await tx`SELECT wv_manage_document_v1(${JSON.stringify(payload)}::jsonb)`;
	});
}

export function createFixtureProposal(query, slug, values) {
	return asFixtureAdmin(query, async (tx) => {
		const [document] = await tx`SELECT id FROM documents WHERE slug=${slug}`;
		assert.ok(document, 'Fixture document must exist');
		const payload = { ...values, documentId: document.id, inspection: { passed: true } };
		await tx`SELECT wv_create_proposal_v1(${JSON.stringify(payload)}::jsonb)`;
	});
}
