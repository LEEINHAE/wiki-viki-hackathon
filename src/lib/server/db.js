// db.js
import { neon } from '@neondatabase/serverless';
import { env } from '$env/dynamic/private';
import { getRequestEvent } from '$app/server';
import { databaseSchema } from '../database-schema.js';

export function db() {
	if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
	const sql = neon(env.DATABASE_URL);
	// Poolers may discard startup settings. Select exactly one schema inside
	// every transaction, so a missing schema never falls back to other data.
	const schema = databaseSchema(env);
	let locals;
	try {
		locals = getRequestEvent().locals;
	} catch {
		locals = {};
	}
	const actorId = String(locals.user?.id || '');
	const role = locals.user?.role || (locals.demo ? 'demo' : '');
	const settings = () => [
		sql`SELECT set_config('search_path',${schema},true)`,
		sql`SELECT set_config('wv.actor_id',${actorId},true),set_config('wv.actor_role',${role},true),set_config('wv.operator','0',true)`
	];
	const isolated = (strings, ...values) => {
		const query = sql(strings, ...values);
		return {
			query,
			then(resolve, reject) {
				return sql
					.transaction([...settings(), query])
					.then((rows) => rows.at(-1))
					.then(resolve, reject);
			}
		};
	};
	isolated.transaction = (queries) =>
		sql
			.transaction([...settings(), ...queries.map((item) => item.query)])
			.then((rows) => rows.slice(2));
	// Authenticate and run a read in the same network round trip. This still
	// checks the live session and account on every request; no role/session cache.
	isolated.sessionRead = async (sessionHash, query) => {
		const rows = await sql.transaction([
			...settings(),
			sql`SELECT u.id,u.handle,u.role,
				set_config('wv.actor_id',u.id::text,true),set_config('wv.actor_role',u.role,true)
				FROM wv_sessions s JOIN wv_users u ON u.id=s.user_id
				WHERE s.token_hash=${sessionHash} AND s.expires_at>NOW() AND u.active`,
			query.query
		]);
		const user = rows.at(-2)[0];
		return {
			user: user ? { id: user.id, handle: user.handle, role: user.role } : null,
			rows: rows.at(-1)
		};
	};
	return isolated;
}
