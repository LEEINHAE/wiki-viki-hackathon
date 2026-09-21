import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { slugify } from '../src/lib/knowledge.js';
import { regexGovernance } from '../src/lib/server/governance.js';

async function main() {
	if (!process.env.DATABASE_URL) throw new Error('Missing database configuration');
	const fixture = JSON.parse(
		await readFile(new URL('../seed-data/prototype-documents.json', import.meta.url), 'utf8')
	);
	const sql = postgres(process.env.DATABASE_URL, {
		max: 1,
		connect_timeout: 10,
		onnotice: () => {}
	});
	const editor = 'Operator-REFERENCE';
	try {
		const results = await sql.begin(async (tx) => {
			await tx`SET LOCAL lock_timeout = '10s'`;
			// Keep reruns serialized, including an older CLI, and wait for regular
			// document/alias/draft writers before taking the conflict-check snapshot.
			await tx`SELECT pg_advisory_xact_lock(hashtext('wiki-viki:seed-prototype'))`;
			await tx`LOCK TABLE documents, redirects, drafts IN SHARE ROW EXCLUSIVE MODE`;
			const results = [];
			let aliasCount = 0;
			for (const item of fixture.documents) {
				const slug = slugify(item.title);
				const aliases = item.aliases
					.map((title) => ({ title, slug: slugify(title) }))
					.filter(
						(alias) =>
							alias.slug && !fixture.documents.some((other) => slugify(other.title) === alias.slug)
					);
				const names = [item.title, ...item.aliases];
				const routes = [slug, ...aliases.map((alias) => alias.slug)];
				const existing = await tx`
					SELECT 'document' AS kind FROM documents WHERE slug=ANY(${routes}::text[]) OR title=ANY(${names}::text[])
					UNION ALL SELECT 'draft' AS kind FROM drafts
						WHERE slug=ANY(${routes}::text[]) OR title=ANY(${names}::text[]) OR aliases ?| ${names}::text[]
							OR (${item.isDraft} AND governance->'seed'->>'referenceDraft'='true'
								AND governance->'seed'->>'source'=${fixture.source})
					UNION ALL SELECT 'alias' AS kind FROM redirects
						WHERE alias_slug=ANY(${routes}::text[]) OR alias_title=ANY(${names}::text[])`;
				if (existing.length) {
					results.push({
						title: item.title,
						status: 'skipped',
						reason: '기존 문서·초안·별칭 유지'
					});
					continue;
				}
				const content = [
					item.summary,
					'> Wiki Viki 프로토타입에서 가져온 예시 문서입니다. 실제 현장의 승인된 운전 기준이나 업무 절차가 아닙니다.',
					...item.sections.map(
						(section) => `## ${section.heading}\n\n${section.paras.join('\n\n')}`
					),
					`## 출처\n\n참조 파일: ${fixture.source}\n\n원본 화면의 분야: ${item.field}\n\n원본 화면에 표시된 출처: ${item.originalSource}`
				].join('\n\n');
				const regex = regexGovernance(content);
				if (!regex.passed) throw new Error('Prototype content failed inspection');
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
					if (!draft) throw new Error('Prototype draft was not inserted');
					results.push({ title: item.title, status: 'draft', id: draft.id });
					continue;
				}
				const [document] = await tx`
					INSERT INTO documents (slug,title,content,editor_handle)
					VALUES (${slug},${item.title},${content},${editor}) RETURNING id`;
				if (!document) throw new Error('Prototype document was not inserted');
				const revisions = await tx`
					INSERT INTO revisions (document_id,content,editor_handle,summary)
					VALUES (${document.id},${content},${editor},'HTML 프로토타입의 예시 문서 적재') RETURNING id`;
				if (revisions.length !== 1) throw new Error('Prototype revision was not inserted');
				for (const alias of aliases) {
					const inserted = await tx`
						INSERT INTO redirects (alias_slug,alias_title,document_id)
						VALUES (${alias.slug},${alias.title},${document.id}) RETURNING id`;
					if (inserted.length !== 1) throw new Error('Prototype alias was not inserted');
					aliasCount++;
				}
				results.push({ title: item.title, status: 'published', id: document.id });
			}
			const documentIds = results.filter((row) => row.status === 'published').map((row) => row.id);
			const draftIds = results.filter((row) => row.status === 'draft').map((row) => row.id);
			// Also detect triggers that remove rows after INSERT RETURNING succeeded.
			const [counts] = await tx`SELECT
				(SELECT count(*)::int FROM documents WHERE id=ANY(${documentIds}::bigint[])) AS documents,
				(SELECT count(*)::int FROM revisions WHERE document_id=ANY(${documentIds}::bigint[])) AS revisions,
				(SELECT count(*)::int FROM redirects WHERE document_id=ANY(${documentIds}::bigint[])) AS aliases,
				(SELECT count(*)::int FROM drafts WHERE id=ANY(${draftIds}::bigint[])) AS drafts`;
			if (
				counts.documents !== documentIds.length ||
				counts.revisions !== documentIds.length ||
				counts.aliases !== aliasCount ||
				counts.drafts !== draftIds.length
			)
				throw new Error('Prototype batch was not fully stored');
			return results;
		});
		// Report actual outcomes only after the entire batch commits.
		console.log(JSON.stringify(results, null, 2));
	} finally {
		await sql.end({ timeout: 5 });
	}
}

// Match the other database CLIs' boundary for deferred driver write failures.
process.once('uncaughtException', () => {
	writeSync(2, '프로토타입 적재가 중단되었습니다. DB 상태를 확인한 뒤 다시 실행해 주세요.\n');
	process.exit(1);
});
main().catch(() => {
	console.error(
		'프로토타입 적재를 완료하지 못했습니다. DB 연결·마이그레이션·잠금 상태를 확인한 뒤 다시 실행해 주세요.'
	);
	process.exitCode = 1;
});
