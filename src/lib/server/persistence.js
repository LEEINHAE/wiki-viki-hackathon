import { db } from './db.js';
import { slugify } from '../wiki-utils.js';

export function aliasRecords(aliases = []) {
	const values = Array.isArray(aliases) ? aliases : aliases.split(',');
	return [
		...new Map(
			values
				.map((title) => ({ title: String(title).trim(), slug: slugify(String(title)) }))
				.filter((item) => item.title && item.slug)
				.map((item) => [item.slug, item])
		).values()
	];
}

export async function persistDocument(values) {
	const titleSlug = slugify(values.title);
	const payload = {
		field: '일반',
		description: '',
		sourceName: '',
		summary: '',
		...values,
		titleSlug,
		aliases: aliasRecords(values.aliases),
		slug: values.slug || titleSlug
	};
	if (payload.slug !== titleSlug && !payload.aliases.some((a) => a.slug === titleSlug))
		payload.aliases.push({ title: values.title, slug: titleSlug });
	const [row] =
		await db()`SELECT wv_save_document_v1(${JSON.stringify(payload)}::jsonb) AS document`;
	return row.document;
}

export function writeFailure(cause) {
	const messages = {
		document_merged:
			'이미 다른 문서에 병합된 문서입니다. 연결된 문서를 편집하거나 운영 계정으로 병합 전 상태를 복원해 주세요.',
		incomplete_snapshot:
			'이 리비전에는 전체 상태가 기록되지 않았습니다. 본문만 되돌릴 수 있습니다.',
		merge_target_changed: '이 리비전의 병합 대상이 변경되었습니다. 현재 병합 상태를 확인해 주세요.',
		unavailable_collection_items:
			'표시되지 않는 문서를 제외할지 확인해 주세요. 확인 전에는 기존 문서 묶음을 변경하지 않습니다.',
		collection_limit: '문서 묶음은 계정당 100개까지 만들 수 있습니다.',
		discussion_resolved: '이미 해결된 토론입니다. 새 의견을 쓰려면 토론을 다시 열어 주세요.',
		forbidden: '이 작업의 권한이 변경되었습니다. 다시 로그인해 권한을 확인해 주세요.',
		version_conflict:
			'다른 변경이 먼저 저장되었습니다. 내 입력은 유지됩니다. 최신 내용을 확인한 뒤 다시 적용해 주세요.',
		name_conflict:
			'같은 제목 또는 주소가 문서·별칭·휴지통에 있습니다. 다른 제목을 선택하거나 기존 문서를 확인해 주세요.',
		alias_conflict: '다른 문서 또는 휴지통에서 사용 중인 별칭입니다. 별칭을 수정해 주세요.',
		document_missing:
			'문서가 삭제되었거나 휴지통에 있습니다. 휴지통 또는 문서 목록을 확인해 주세요.',
		draft_missing: '초안이 이미 게시되었거나 삭제되었습니다. 초안 목록을 확인해 주세요.',
		content_blocked: '콘텐츠 검사에 실패했습니다. 검사 사유를 확인하고 내용을 수정해 주세요.'
	};
	const code = Object.keys(messages).find((key) => cause.message === key);
	return {
		status: code === 'forbidden' ? 403 : code ? 409 : 500,
		message:
			messages[code] ||
			'변경을 저장하지 못했습니다. 입력을 보존한 상태로 잠시 후 다시 시도해 주세요.'
	};
}
