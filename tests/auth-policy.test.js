import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permits, requiredRole, canAccessRoute, localReturn } from '../src/lib/auth-policy.js';
import { hashPassword, checkPassword, tokenHash } from '../src/lib/server/passwords.js';
test('server permissions distinguish reading, editing, review and operations', () => {
	for (const role of ['reader', 'editor', 'reviewer', 'admin'])
		assert.equal(permits(role, 'reader'), true);
	assert.equal(permits('anonymous', 'reader'), false);
	assert.equal(permits('reader', requiredRole('/drafts', 'GET')), false);
	assert.equal(permits('editor', requiredRole('/drafts', 'POST', 'publishSelected')), false);
	assert.equal(permits('reviewer', requiredRole('/edit/a', 'POST', 'delete')), false);
	assert.equal(permits('admin', requiredRole('/trash', 'POST', 'restore')), true);
	assert.equal(permits('reader', requiredRole('/api/wikify', 'POST')), false);
	assert.equal(permits('reader', requiredRole('/api/uploads/chunks', 'GET')), false);
	assert.equal(permits('editor', requiredRole('/api/uploads/chunks', 'POST')), true);
	assert.equal(localReturn('//other.example'), '/');
	assert.equal(localReturn('/\\evil'), '/');
	assert.equal(localReturn('/wiki/rfcc'), '/wiki/rfcc');
});
test('administrator document review workflows are disabled without changing other roles', () => {
	for (const method of ['GET', 'HEAD', 'POST']) {
		for (const path of ['/proposals/rfcc', '/manage/rfcc', '/reviews']) {
			assert.equal(canAccessRoute('admin', path, method), false);
			assert.equal(canAccessRoute('reviewer', path, method), true);
		}
	}
	assert.equal(canAccessRoute('admin', '/proposals/rfcc', 'POST', 'decide'), false);
	assert.equal(canAccessRoute('reader', '/proposals/rfcc', 'POST', 'create'), true);
	assert.equal(canAccessRoute('reader', '/proposals/rfcc', 'POST', 'decide'), false);
	assert.equal(canAccessRoute('editor', '/manage/rfcc'), false);
	assert.equal(canAccessRoute(undefined, '/proposals/rfcc'), false);
	for (const path of ['/admin/users', '/edit/rfcc', '/discussion/rfcc', '/history/rfcc', '/drafts'])
		assert.equal(canAccessRoute('admin', path), true);
});
test('password hashes are salted, verify without plaintext and reject malformed input', async () => {
	const password = 'synthetic-test-password-only';
	const first = await hashPassword(password),
		second = await hashPassword(password);
	assert.notEqual(first, second);
	assert.ok(!first.includes(password));
	assert.equal(await checkPassword(password, first), true);
	assert.equal(await checkPassword(password + 'x', first), false);
	assert.equal(await checkPassword(password, 'malformed'), false);
	await assert.rejects(() => hashPassword('short'));
	assert.equal(tokenHash('token').length, 64);
});
