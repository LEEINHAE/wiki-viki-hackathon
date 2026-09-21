import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { parseUpload, MAX_UPLOAD_BYTES } from '$lib/server/parser.js';
import { structureDocuments, semanticGovernance, aiErrorMessage } from '$lib/server/openai.js';
import { regexGovernance, validHandle } from '$lib/server/governance.js';
import { db } from '$lib/server/db.js';
import { slugify } from '$lib/server/wiki.js';
import { excerpt, wikiTargets, linkTerms } from '$lib/wiki-utils.js';
import prototypeDocuments from '$lib/data/prototype-documents.json';

export const config = { maxDuration: 300 };

export async function POST({ request }) {
	let form;
	try {
		form = await request.formData();
	} catch {
		return json({ message: '파일을 읽을 수 없습니다. 다시 선택해 주세요.' }, { status: 400 });
	}
	const demo = form.get('demo') === 'true';
	const basic = form.get('basic') === 'true';
	const file = form.get('file');
	const editor = form.get('editor')?.toString() || 'Operator-07';
	if (!validHandle(editor))
		return json(
			{ message: 'Operator-07 또는 Editor-01 형식의 익명 이름을 사용해 주세요.' },
			{ status: 400 }
		);
	if (!demo && (!(file instanceof File) || !file.size))
		return json({ message: 'DOCX, PDF, PPTX 파일을 선택해 주세요.' }, { status: 400 });
	if (!demo && file.size > MAX_UPLOAD_BYTES)
		return json({ message: '파일 크기는 40MB 이하여야 합니다.' }, { status: 413 });
	if (!demo && !/\.(docx|pdf|pptx)$/i.test(file.name))
		return json({ message: 'DOCX, PDF, PPTX 파일만 지원합니다.' }, { status: 415 });
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
			try {
				send({ type: 'progress', stage: '문서에서 텍스트를 추출하는 중…', progress: 10 });
				let generated;
				let mode;
				let sourceName;
				if (demo) {
					sourceName = '공장약어집.pdf · 프로토타입 예시';
					mode = 'demo';
					generated = prototypeDocuments.map((doc) => ({
						title: doc.title,
						field: doc.field,
						description: doc.summary,
						aliases: [doc.aka],
						content: `> 프로토타입 시연용 예시입니다. 실제 업무 기준으로 사용하기 전에 원문과 대조해 주세요.\n\n${doc.sections.map((section) => `## ${section.heading}\n\n${section.paras.join('\n\n')}`).join('\n\n')}`
					}));
				} else {
					const text = await parseUpload(file);
					if (!text.trim())
						throw new Error(
							'텍스트를 추출할 수 없습니다. 스캔 문서는 텍스트가 있는 파일로 올려 주세요.'
						);
					const sourceCheck = regexGovernance(text);
					if (!sourceCheck.passed)
						throw new Error(
							`원문에 게시가 제한되는 내용이 있습니다: ${sourceCheck.reasons.join(', ')}. 제거 후 다시 올려 주세요.`
						);
					send({ type: 'progress', stage: '용어를 찾아 문서별 초안을 정리하는 중…', progress: 35 });
					const structured = await structureDocuments(text, file.name, { useAI: !basic });
					mode = structured.mode;
					sourceName = file.name;
					generated = structured.documents.map((doc) => ({
						...doc,
						content: doc.sections
							.map((section) => `## ${section.heading}\n\n${section.content}`)
							.join('\n\n')
					}));
				}
				send({ type: 'progress', stage: '문서 간 연결과 콘텐츠를 확인하는 중…', progress: 70 });
				const existing = await db()`SELECT title FROM documents`;
				const knownTitles = new Set([
					...existing.map((doc) => doc.title),
					...generated.map((doc) => doc.title)
				]);
				const records = [];
				for (const doc of generated) {
					doc.content = linkTerms(
						doc.content,
						[...(doc.suggestedLinks || []), ...generated.map((item) => item.title)].filter(
							(title) => title !== doc.title && knownTitles.has(title)
						)
					);
					const regex = regexGovernance(`${doc.title}\n${doc.description}\n${doc.content}`);
					const semantic =
						mode === 'ai' && regex.passed
							? await semanticGovernance(doc.content)
							: { passed: regex.passed, skipped: true, reasons: [] };
					const governance = {
						passed: regex.passed && semantic.passed,
						regex,
						semantic,
						generationMode: mode
					};
					records.push({
						...doc,
						slug: slugify(doc.title),
						description: doc.description || excerpt(doc.content),
						governance,
						status: governance.passed ? 'review' : 'blocked',
						sourceName,
						editor
					});
				}
				if (records.some((doc) => !doc.slug || !doc.content.trim()))
					throw new Error('초안의 제목 또는 내용이 비어 있습니다. 다시 시도해 주세요.');
				send({ type: 'progress', stage: '검토할 초안을 저장하는 중…', progress: 90 });
				// One transaction prevents partial batches when any draft cannot be saved.
				const sql = db();
				const rows = await sql.transaction(
					records.map(
						(doc) =>
							sql`INSERT INTO drafts (title,slug,content,source_name,aliases,governance,status,editor_handle,field,description) VALUES (${doc.title},${doc.slug},${doc.content},${doc.sourceName},${JSON.stringify(doc.aliases || [])}::jsonb,${JSON.stringify(doc.governance)}::jsonb,${doc.status},${doc.editor},${doc.field || '일반'},${doc.description}) RETURNING id,title,description,content,status`
					)
				);
				const drafts = rows
					.flat()
					.map(({ content, ...doc }) => ({ ...doc, links: wikiTargets(content).length }));
				send({
					type: 'done',
					drafts,
					links: drafts.reduce((sum, doc) => sum + doc.links, 0),
					mode,
					semanticSkipped: mode !== 'ai' || !env.OPENAI_API_KEY
				});
			} catch (cause) {
				console.error('Wikifier failed:', cause.status || cause.code || cause.name);
				const providerError = !!cause.status || /APIConnection/.test(cause.name || '');
				send({
					type: 'error',
					canUseBasic: providerError,
					message: providerError
						? aiErrorMessage(cause)
						: cause.message?.startsWith('Error connecting')
							? '저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
							: cause.message || '초안을 만들지 못했습니다. 다시 시도해 주세요.'
				});
			} finally {
				controller.close();
			}
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' }
	});
}
