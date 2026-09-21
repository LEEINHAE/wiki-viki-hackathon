import { actorHandle } from '$lib/server/auth.js';
import { assembleTransfer, transferFailure } from '$lib/server/upload-buffers.js';
import { createHash, randomUUID } from 'node:crypto';
import {
	uploadOwner,
	beginUpload,
	updateUpload,
	storeUploadSources
} from '$lib/server/upload-jobs.js';
import { acquireAIRequest } from '$lib/server/ai-limits.js';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { parseUploadDetailed, MAX_UPLOAD_BYTES, UploadError } from '$lib/server/parser.js';
import { structureDocuments, semanticGovernance, aiErrorMessage } from '$lib/server/openai.js';
import {
	assertSafeForAI,
	validHandle,
	inspectContent,
	contentPolicy,
	ContentBlockedError
} from '$lib/server/governance.js';
import { db } from '$lib/server/db.js';
import { slugify } from '$lib/server/wiki.js';
import { excerpt, wikiTargets, linkTerms } from '$lib/wiki-utils.js';
import prototypeDocuments from '$lib/data/prototype-documents.json';

export const config = { maxDuration: 300 };

export async function POST({ request, cookies, url, getClientAddress }) {
	if (request.headers.get('origin') !== url.origin)
		return json({ message: '같은 사이트에서 업로드해 주세요.' }, { status: 403 });
	let form;
	try {
		form = await request.formData();
	} catch {
		return json({ message: '파일을 읽을 수 없습니다. 다시 선택해 주세요.' }, { status: 400 });
	}
	const demo = form.get('demo') === 'true';
	const basic = form.get('basic') === 'true';
	let file = form.get('file');
	if (!demo && form.get('uploadToken')) {
		try {
			file = await assembleTransfer(uploadOwner(cookies), String(form.get('uploadToken')));
		} catch (cause) {
			const failure = transferFailure(cause);
			return json({ message: failure.message }, { status: failure.status });
		}
	}
	const editor = actorHandle(form.get('editor')?.toString() || 'Operator-07');
	if (!validHandle(editor))
		return json(
			{ message: 'Operator-07 또는 Editor-01 형식의 익명 이름을 사용해 주세요.' },
			{ status: 400 }
		);
	if (!demo && (!(file instanceof File) || !file.size))
		return json({ message: 'DOCX, PDF, XLSX, PPTX 파일을 선택해 주세요.' }, { status: 400 });
	if (!demo && file.size > MAX_UPLOAD_BYTES)
		return json({ message: '파일 크기는 10MB 이하여야 합니다.' }, { status: 413 });
	if (!demo && !/\.(docx|pdf|xlsx|pptx)$/i.test(file.name))
		return json({ message: 'DOCX, PDF, XLSX, PPTX 파일만 지원합니다.' }, { status: 415 });
	let job, run;
	try {
		assertSafeForAI(demo ? '시연 자료' : file.name);
		const hash = createHash('sha256')
			.update(demo ? JSON.stringify(prototypeDocuments) : Buffer.from(await file.arrayBuffer()))
			.digest('hex');
		const owner = uploadOwner(cookies, { create: true, secure: url.protocol === 'https:' });
		const requestKey = /^[a-f0-9-]{36}$/.test(String(form.get('requestKey') || ''))
			? String(form.get('requestKey'))
			: randomUUID();
		({ job, run } = await beginUpload({
			owner,
			requestKey,
			hash,
			name: demo ? '공장약어집.pdf · 프로토타입 예시' : file.name,
			size: demo ? 0 : file.size,
			mode: demo ? 'demo' : basic || !env.OPENAI_API_KEY ? 'basic' : 'ai',
			retry: form.get('retry') === 'true' || contentPolicy.mode === 'relaxed'
		}));
	} catch (cause) {
		return json(
			{
				message:
					cause instanceof ContentBlockedError
						? '파일명의 콘텐츠 검사에서 차단되었습니다. 파일명을 확인해 주세요.'
						: '업로드 작업을 등록하지 못했습니다. 작업 목록을 확인하고 다시 시도해 주세요.'
			},
			{ status: cause instanceof ContentBlockedError ? 400 : 503 }
		);
	}
	if (!run)
		return new Response(
			JSON.stringify(
				job.state === 'completed'
					? { ...job.result, reused: true }
					: {
							type: 'pending',
							jobId: job.id,
							state: job.state,
							mode: job.mode,
							stage: job.stage,
							message: job.message
						}
			) + '\n',
			{
				headers: {
					'content-type': 'application/x-ndjson; charset=utf-8',
					'cache-control': 'no-store'
				}
			}
		);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let connected = true;
			let lease;
			const deadline = AbortSignal.timeout(270000);
			const semantic = (text) => semanticGovernance(text, { signal: deadline });
			const send = (event) => {
				if (connected)
					try {
						controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
					} catch {
						connected = false;
					}
			};
			try {
				await updateUpload(job, 'extracting', '문서에서 텍스트를 추출하는 중…');
				send({ type: 'progress', jobId: job.id, stage: '문서에서 텍스트를 추출하는 중…' });
				let generated;
				let mode;
				let sourceName;
				let segments = [];
				if (demo) {
					sourceName = '공장약어집.pdf · 프로토타입 예시';
					mode = 'demo';
					segments = prototypeDocuments.map((d, i) => ({
						kind: 'example',
						position: i + 1,
						label: `예시 항목 ${i + 1}: ${d.title}`,
						text: d.sections.map((s) => s.paras.join('\n\n')).join('\n\n')
					}));
					await updateUpload(job, 'inspecting', '시연 자료 검사 중');
					await storeUploadSources(job, segments);
					generated = prototypeDocuments.map((doc) => ({
						title: doc.title,
						field: doc.field,
						description: doc.summary,
						aliases: [doc.aka],
						content: `> 프로토타입 시연용 예시입니다. 실제 업무 기준으로 사용하기 전에 원문과 대조해 주세요.\n\n${doc.sections.map((section) => `## ${section.heading}\n\n${section.paras.join('\n\n')}`).join('\n\n')}`
					}));
				} else {
					const extracted = await parseUploadDetailed(file);
					const text = extracted.text;
					segments = extracted.segments;
					if (!text.trim())
						throw new UploadError(
							'텍스트를 추출할 수 없습니다. 스캔 문서는 텍스트가 있는 파일로 올려 주세요.'
						);
					assertSafeForAI(file.name, text);
					await updateUpload(job, 'inspecting', '추출 원문을 검사하는 중…');
					send({ type: 'progress', jobId: job.id, stage: '추출 원문을 검사하는 중…' });
					if (!basic && env.OPENAI_API_KEY) {
						lease = await acquireAIRequest(getClientAddress(), `upload:${job.id}`);
						if (lease.error)
							throw new UploadError(
								'AI 요청이 많거나 같은 작업이 진행 중입니다. 작업 목록을 확인하고 잠시 후 다시 시도해 주세요.'
							);
					}
					const sourceCheck = await inspectContent([file.name, text], basic ? null : semantic);
					if (!sourceCheck.passed)
						throw new UploadError(
							`원문에 게시가 제한되는 내용이 있습니다: ${[...sourceCheck.regex.reasons, ...sourceCheck.semantic.reasons].join(', ')}. 제거 후 다시 올려 주세요.`
						);
					await storeUploadSources(job, segments);
					await updateUpload(
						job,
						'generating',
						'용어·개념·업무 절차를 구분해 의미별 초안을 만드는 중…'
					);
					send({
						type: 'progress',
						jobId: job.id,
						stage: '용어·개념·업무 절차를 구분해 의미별 초안을 만드는 중…'
					});
					const structured = await structureDocuments(text, file.name, {
						useAI: !basic,
						signal: deadline
					});
					mode = structured.mode;
					sourceName = file.name;
					generated = structured.documents.map((doc) => ({
						...doc,
						content: doc.sections
							.map((section) => `## ${section.heading}\n\n${section.content}`)
							.join('\n\n')
					}));
				}
				send({ type: 'progress', stage: '문서 간 연결과 콘텐츠를 확인하는 중…' });
				const existing =
					await db()`SELECT title FROM wv_visible_documents WHERE deleted_at IS NULL`;
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
					const inspection = await inspectContent(
						[doc.title, doc.description, doc.content, ...(doc.aliases || []), sourceName],
						mode === 'ai' ? semantic : null
					);
					const governance = {
						...inspection,
						generationMode: mode,
						aiGenerated: mode === 'ai',
						uploadJobId: job.id
					};
					records.push({
						...doc,
						aliases: doc.aliases || [],
						field: doc.field || '일반',
						links: wikiTargets(doc.content).length,
						slug: slugify(doc.title),
						description: doc.description || excerpt(doc.content),
						governance,
						status: governance.passed ? 'review' : 'blocked',
						sourceName,
						editor
					});
				}
				if (
					records.length < 1 ||
					records.length > 8 ||
					new Set(records.map((d) => d.slug)).size !== records.length ||
					records.some(
						(doc) =>
							!doc.slug ||
							!doc.content.trim() ||
							doc.title.length > 200 ||
							doc.content.length > 200000 ||
							doc.aliases.length > 50 ||
							doc.description.length > 2000
					)
				)
					throw new UploadError(
						'초안 수·제목·내용을 확인할 수 없습니다. 중복 제목 또는 빈 내용이 있습니다. 다시 시도해 주세요.'
					);

				await updateUpload(job, 'saving', '검토할 초안을 저장하는 중…');
				send({ type: 'progress', jobId: job.id, stage: '검토할 초안을 저장하는 중…' });
				const [row] =
					await db()`SELECT wv_finish_upload_v1(${JSON.stringify({ jobId: job.id, attempt: job.attempt, records, editor, mode, links: records.reduce((n, d) => n + d.links, 0), semanticSkipped: records.some((record) => record.governance.semantic.skipped) })}::jsonb) AS result`;
				send(row.result);
			} catch (cause) {
				console.error('Wikifier failed:', cause.status || cause.code || cause.name);
				const providerError = !!cause.status || /APIConnection/.test(cause.name || '');
				const message = providerError
					? aiErrorMessage(cause)
					: cause instanceof UploadError || cause instanceof ContentBlockedError
						? cause.message
						: '초안을 만들지 못했습니다. 작업 목록에서 상태를 확인하고 다시 시도해 주세요.';
				await updateUpload(job, 'failed', '작업 실패', message).catch(() => {});
				send({
					jobId: job.id,
					type: 'error',
					canUseBasic: providerError,
					message: providerError
						? aiErrorMessage(cause)
						: cause instanceof UploadError || cause instanceof ContentBlockedError
							? cause.message
							: '초안을 만들지 못했습니다. 저장소 상태를 확인하고 다시 시도해 주세요.'
				});
			} finally {
				if (lease?.release) await lease.release().catch(() => {});
				if (connected)
					try {
						controller.close();
					} catch {}
			}
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' }
	});
}
