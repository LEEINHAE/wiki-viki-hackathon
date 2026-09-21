// db.js
import { neon } from '@neondatabase/serverless';
import { env } from '$env/dynamic/private';

export function db() {
	if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
	return neon(env.DATABASE_URL); // 매 호출마다 가벼운 client 생성, 상태 없음
}
