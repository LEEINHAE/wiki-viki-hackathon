import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password) {
	if (typeof password !== 'string' || password.length < 12 || password.length > 128)
		throw Error('password_length');
	const salt = randomBytes(16).toString('hex');
	const hash = await derive(password, salt, 64, options);
	return `scrypt-v1$${salt}$${Buffer.from(hash).toString('hex')}`;
}
export async function checkPassword(password, stored) {
	if (typeof password !== 'string' || password.length > 128) return false;
	const [kind, salt, digest] = String(stored || '').split('$');
	if (kind !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(digest))
		return false;
	const actual = await derive(password, salt, 64, options);
	return timingSafeEqual(Buffer.from(actual), Buffer.from(digest, 'hex'));
}
