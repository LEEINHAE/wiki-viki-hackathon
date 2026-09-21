import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { searchOptions } from '$lib/search.js';
import { assertSafeForAI, ContentBlockedError, contentPolicy } from '$lib/server/governance.js';
import { searchDocuments } from '$lib/server/search.js';
import { evidencePassages } from '$lib/server/answer-contract.js';
import { explainSearch } from '$lib/server/openai.js';
import { acquireAIRequest } from '$lib/server/ai-limits.js';
import { db } from '$lib/server/db.js';
const reply = (body, status = 200) =>
	json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST({ request, url, getClientAddress }) {
	if (request.headers.get('origin') !== url.origin)
		return reply({ state: 'error', message: '같은 사이트에서 요청해 주세요.' }, 403);
	let lease;
	try {
		const raw = await request.text();
		if (raw.length > 4000)
			return reply({ state: 'error', message: '검색 조건이 너무 깁니다.' }, 400);
		let input;
		try {
			input = JSON.parse(raw);
		} catch {
			return reply({ state: 'error', message: '검색 조건을 확인해 주세요.' }, 400);
		}
		if (typeof input.q !== 'string' || !input.q.trim() || input.q.length > 200)
			return reply({ state: 'error', message: '검색어는 1–200자로 입력해 주세요.' }, 400);
		const params = new URLSearchParams(
			Object.fromEntries(
				['q', 'field', 'tag', 'state', 'days', 'sort'].map((k) => [
					k,
					typeof input[k] === 'string' ? input[k] : ''
				])
			)
		);
		const options = { ...searchOptions(params), page: 1, limit: 6 };
		assertSafeForAI(options.q);
		if (!env.OPENAI_API_KEY)
			return reply(
				{
					state: 'unavailable',
					message:
						'AI 설명을 사용할 수 없습니다. 검색 결과에서 원문을 확인하거나 나중에 다시 시도해 주세요.'
				},
				503
			);
		const { results } = await searchDocuments(options);
		if (!results.length)
			return reply({
				state: 'insufficient',
				message: '선택한 검색 조건에 맞는 게시 문서가 없습니다.'
			});
		const ids = results.map((d) => d.id);
		const documents =
			await db()`SELECT d.id,d.slug,d.title,r.content,d.source_name,d.updated_at::text AS version,r.id AS revision_id FROM wv_current_documents d
      JOIN LATERAL(SELECT id,content FROM wv_visible_revisions WHERE document_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
      WHERE d.id=ANY(${ids}::bigint[]) AND d.deleted_at IS NULL AND d.wv_archived_at IS NULL ORDER BY array_position(${ids}::bigint[],d.id)`;
		const sources = evidencePassages(documents, options.q, { policy: contentPolicy });
		if (!sources.length)
			return reply({
				state: 'insufficient',
				message: '답변을 뒷받침할 본문 문단이나 기록된 리비전이 부족합니다.'
			});
		lease = await acquireAIRequest(
			getClientAddress(),
			JSON.stringify({ options, revisions: sources.map((s) => s.id) })
		);
		if (lease.error)
			return reply(
				{
					state: lease.error,
					message:
						lease.error === 'duplicate'
							? '같은 설명을 이미 생성 중입니다. 진행 중인 요청을 확인해 주세요.'
							: 'AI 요청이 많습니다. 최대 10분 후 다시 시도해 주세요.'
				},
				429
			);
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(115000)]);
		const result = await explainSearch(options.q, sources, { signal });
		const current =
			await db()`SELECT id,updated_at::text AS version FROM wv_current_documents WHERE id=ANY(${ids}::bigint[]) AND deleted_at IS NULL AND wv_archived_at IS NULL`;
		if (
			documents.some(
				(d) => !current.some((c) => String(c.id) === String(d.id) && c.version === d.version)
			)
		)
			return reply(
				{
					state: 'stale',
					message: '생성 중 근거 문서가 변경되었습니다. 최신 결과로 다시 요청해 주세요.'
				},
				409
			);
		return reply({
			state: result.insufficient ? 'insufficient' : 'ready',
			...result,
			message: result.insufficient
				? '선택한 문서만으로 질문에 답할 근거가 충분하지 않습니다.'
				: undefined
		});
	} catch (cause) {
		if (cause instanceof ContentBlockedError)
			return reply(
				{
					state: 'blocked',
					message:
						'검색어 또는 근거 문서의 콘텐츠 검사에서 외부 전송이 차단되었습니다. 원문을 확인해 주세요.'
				},
				400
			);
		if (request.signal.aborted || cause.name === 'AbortError' || cause.name === 'TimeoutError')
			return reply(
				{
					state: 'cancelled',
					message:
						'AI 요청이 취소되었거나 제한 시간을 넘었습니다. 원문 검색을 계속 이용할 수 있습니다.'
				},
				408
			);
		console.error('Search answer failed:', cause.code || cause.name);
		return reply(
			{
				state: 'error',
				message:
					'AI 설명을 생성하지 못했습니다. 원문 검색은 계속 사용할 수 있습니다. 잠시 후 다시 시도해 주세요.'
			},
			503
		);
	} finally {
		if (lease?.release) await lease.release().catch(() => {});
	}
}
