import OpenAI from 'openai';
import { env } from '$env/dynamic/private';

export async function structureDocument(sourceText, sourceName = '업로드한 문서') {
	if (!env.OPENAI_API_KEY) return fallbackStructure(sourceText, sourceName);
	const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
	const response = await openai.responses.create({
		model: env.OPENAI_MODEL || 'gpt-5-mini',
		input: [
			{ role: 'system', content: '제공된 텍스트만 사용해 간결한 한국어 사내 위키 문서로 구성하세요. 원문에 없는 사실을 추가하지 마세요. 불확실한 내용은 [검토 필요]로 표시하고 JSON으로 반환하세요.' },
			{ role: 'user', content: `원본: ${sourceName}\n\n${sourceText}` }
		],
		text: {
			format: {
				type: 'json_schema',
				name: 'wiki_document',
				strict: true,
				schema: {
					type: 'object', additionalProperties: false,
					required: ['title', 'sections', 'suggestedLinks', 'aliases'],
					properties: {
						title: { type: 'string' },
						sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heading', 'content'], properties: { heading: { type: 'string' }, content: { type: 'string' } } } },
						suggestedLinks: { type: 'array', items: { type: 'string' } },
						aliases: { type: 'array', items: { type: 'string' } }
					}
				}
			}
		}
	});
	return JSON.parse(response.output_text);
}

export async function semanticGovernance(text) {
	if (!env.OPENAI_API_KEY) return { passed: true, reasons: [], skipped: true };
	const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
	const response = await openai.responses.create({
		model: env.OPENAI_MODEL || 'gpt-5-mini',
		input: `이 텍스트에 실명, 개인 식별 정보, 개인 연락처, 인사·급여 정보 또는 기밀 자료가 있는지 검사하세요. 이유는 한국어로 작성하고 JSON만 반환하세요: {"passed":boolean,"reasons":string[]}\n\n${text}`
	});
	try { return JSON.parse(response.output_text); } catch { return { passed: false, reasons: ['의미 기반 콘텐츠 보호 검사 결과가 올바르지 않습니다.'] }; }
}

function fallbackStructure(text, filename) {
	const clean = text.trim();
	const first = clean.split(/\n+/)[0]?.replace(/^#+\s*/, '').slice(0, 100);
	return { title: first || filename.replace(/\.(docx|pdf)$/i, ''), sections: [{ heading: '개요', content: clean }], suggestedLinks: [], aliases: [] };
}
