import { readFile } from 'node:fs/promises';
import { seedDocument } from './seed-helpers.js';
import { slugify } from '../src/lib/wiki-utils.js';
import { inspectContent } from '../src/lib/content-policy.js';

export async function seedPrototype(tx) {
	await tx`SELECT set_config('wv.operator','1',true)`;
	await tx`SELECT pg_advisory_xact_lock(21470921,2)`;
	const examples = JSON.parse(
		await readFile(new URL('../src/lib/data/prototype-documents.json', import.meta.url), 'utf8')
	);
	const counts = { documents: 0, drafts: 0 };
	for (const item of examples) {
		const aliases = item.aka
			.split(' · ')
			.map((s) => s.trim())
			.filter(Boolean);
		const content =
			'> 기능 검증용 예시입니다. 승인된 현장 운전 기준·업무 절차 또는 검증된 거래 정보가 아닙니다.\n\n' +
			item.sections.map((s) => `## ${s.heading}\n\n${s.paras.join('\n\n')}`).join('\n\n');
		const sourceName = '저장소 예시 자료: prototype-documents.json';
		if (!item.isDraft) {
			const result = await seedDocument(tx, {
				title: item.title,
				aliases,
				content,
				field: item.field,
				description: item.summary,
				sourceName,
				example: true,
				tags: ['예시']
			});
			if (result.created) counts.documents++;
			continue;
		}
		const slug = slugify(item.title);
		const collisions =
			await tx`SELECT 1 FROM documents WHERE slug=${slug} OR lower(title)=lower(${item.title}) UNION SELECT 1 FROM redirects WHERE alias_slug=${slug} UNION SELECT 1 FROM drafts WHERE slug=${slug} OR lower(title)=lower(${item.title})`;
		if (collisions.length) continue;
		const governance = await inspectContent([item.title, content, sourceName, ...aliases]);
		if (!governance.passed) throw Error('seed_content_blocked');
		await tx`INSERT INTO drafts(title,slug,content,aliases,source_name,field,description,governance,status,editor_handle)
		VALUES(${item.title},${slug},${content},${tx.json(aliases)},${sourceName},${item.field},${item.summary},${tx.json({ ...governance, seed: true, generationMode: 'demo', reviewState: 'example' })},'review','Operator-A')`;
		counts.drafts++;
	}
	return counts;
}
