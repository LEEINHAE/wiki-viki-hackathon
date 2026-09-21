import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { slugify } from '../src/lib/knowledge.js';
import { regexGovernance } from '../src/lib/server/governance.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');

const fixture = JSON.parse(
	await readFile(new URL('../seed-data/prototype-documents.json', import.meta.url), 'utf8')
);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const editor = 'Operator-REFERENCE';

try {
	const results = await sql.begin(async (tx) => {
		// Serialize reruns so the reference draft is not duplicated either.
		await tx`SELECT pg_advisory_xact_lock(hashtext('wiki-viki:seed-prototype'))`;
		const results = [];
		for (const item of fixture.documents) {
			const slug = slugify(item.title);
			const existing = await tx`
				SELECT 'document' AS kind FROM documents WHERE slug=${slug} OR title=${item.title}
				UNION ALL SELECT 'draft' AS kind FROM drafts WHERE slug=${slug} OR title=${item.title}
				UNION ALL SELECT 'alias' AS kind FROM redirects WHERE alias_slug=${slug}`;
			if (existing.length) {
				results.push({ title: item.title, status: 'skipped', reason: '기존 문서·초안·별칭 유지' });
				continue;
			}
			const content = [
				item.summary,
				'> Wiki Viki 프로토타입에서 가져온 예시 문서입니다. 실제 현장의 승인된 운전 기준이나 업무 절차가 아닙니다.',
				...item.sections.map((section) => `## ${section.heading}\n\n${section.paras.join('\n\n')}`),
				`## 출처\n\n참조 파일: ${fixture.source}\n\n원본 화면의 분야: ${item.field}\n\n원본 화면에 표시된 출처: ${item.originalSource}`
			].join('\n\n');
			const regex = regexGovernance(content);
			if (!regex.passed) throw new Error(`${item.title}: ${regex.reasons.join(', ')}`);
			if (item.isDraft) {
				const governance = {
					passed: true,
					regex,
					semantic: { passed: true, skipped: true, reasons: [] },
					seed: { source: fixture.source, sha256: fixture.sha256, referenceDraft: true }
				};
				const [draft] = await tx`
					INSERT INTO drafts (title,slug,content,source_name,aliases,governance,status,editor_handle)
					VALUES (${item.title},${slug},${content},${fixture.source},${tx.json(item.aliases)},${tx.json(governance)},'review',${editor})
					RETURNING id`;
				results.push({ title: item.title, status: 'draft', id: draft.id });
				continue;
			}
			const [document] = await tx`
				INSERT INTO documents (slug,title,content,editor_handle)
				VALUES (${slug},${item.title},${content},${editor}) RETURNING id`;
			await tx`
				INSERT INTO revisions (document_id,content,editor_handle,summary)
				VALUES (${document.id},${content},${editor},'HTML 프로토타입의 예시 문서 적재')`;
			for (const alias of item.aliases) {
				const aliasSlug = slugify(alias);
				if (!aliasSlug || fixture.documents.some((other) => slugify(other.title) === aliasSlug))
					continue;
				await tx`
					INSERT INTO redirects (alias_slug,alias_title,document_id)
					SELECT ${aliasSlug},${alias},${document.id}
					WHERE NOT EXISTS (SELECT 1 FROM documents WHERE slug=${aliasSlug})
					ON CONFLICT (alias_slug) DO NOTHING`;
			}
			results.push({ title: item.title, status: 'published', id: document.id });
		}
		return results;
	});
	console.log(JSON.stringify(results, null, 2));
} finally {
	await sql.end();
}
