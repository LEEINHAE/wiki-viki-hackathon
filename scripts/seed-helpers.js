import { slugify, excerpt } from '../src/lib/wiki-utils.js';
import { inspectContent } from '../src/lib/content-policy.js';
export async function seedDocument(tx, item) {
	const slug = item.slug || slugify(item.title);
	await tx`SELECT set_config('wv.operator','1',true)`;
	await tx`SELECT pg_advisory_xact_lock(21470921,2)`;
	const existing =
		await tx`SELECT id FROM documents WHERE slug=${slug} OR lower(title)=lower(${item.title}) UNION SELECT document_id AS id FROM redirects WHERE alias_slug=${slug} UNION SELECT id FROM drafts WHERE slug=${slug} OR lower(title)=lower(${item.title})`;
	if (existing.length) return { created: false, id: existing[0].id };
	const aliases = [
		...new Map(
			(item.aliases || [])
				.map((title) => ({ title, slug: slugify(title) }))
				.filter((a) => a.slug && a.slug !== slug)
				.map((a) => [a.slug, a])
		).values()
	];
	const governance = await inspectContent([
		item.title,
		item.content,
		item.sourceName || '',
		...aliases.map((a) => a.title)
	]);
	if (!governance.passed) throw Error('seed_content_blocked');
	const safe = [];
	for (const a of aliases) {
		const collision =
			await tx`SELECT 1 FROM documents WHERE slug=${a.slug} UNION SELECT 1 FROM redirects WHERE alias_slug=${a.slug}`;
		if (!collision.length) safe.push(a);
	}
	const [row] =
		await tx`SELECT wv_save_document_v1(${tx.json({ title: item.title, titleSlug: slugify(item.title), slug, content: item.content, editor: 'Operator-A', field: item.field || '일반', description: item.description || excerpt(item.content), sourceName: item.sourceName || '기능 검증용 예시', aliases: safe, tags: item.tags || [], governance: { ...governance, ...(item.example ? { reviewState: 'example' } : {}) }, summary: item.example ? '예시 문서 최초 생성' : '기본 안내 최초 생성' })}::jsonb) AS doc`;
	return { created: true, id: row.doc.id };
}
