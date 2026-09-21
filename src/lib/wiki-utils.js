export const fields = ['일반', '공정', '설비', '유틸리티', '절차', '안전', '총무', '외부'];

export function slugify(value) {
	return value
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/[^\p{L}\p{N}:.~-]/gu, '')
		.replace(/-+/g, '-')
		.toLowerCase();
}

export function plainText(content = '') {
	return content
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[#*`>_~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function excerpt(content = '', length = 180) {
	const text = plainText(content);
	return text.length > length ? text.slice(0, length) + '…' : text;
}

export function wikiTargets(content = '') {
	return [
		...new Set(
			[...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
				.map((match) => match[1].trim())
				.filter((target) => !/^(?:https?:\/\/|파일:|분류:)/i.test(target))
		)
	];
}

export function linkTerms(content, terms) {
	const candidates = [...new Set(terms.filter((term) => term && term.length > 1))].sort(
		(a, b) => b.length - a.length
	);
	if (!candidates.length) return content;
	const escaped = candidates.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	const pattern = new RegExp(
		`(?<![\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_]|[은는이가을를의에와과로])`,
		'gu'
	);
	const linked = new Set(wikiTargets(content));
	return content
		.split(/(```[\s\S]*?```|`[^`]*`|\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\)|^#{1,6}[^\n]*$)/gm)
		.map((part, index) =>
			index % 2
				? part
				: part.replace(pattern, (term) => {
						if (linked.has(term)) return term;
						linked.add(term);
						return `[[${term}]]`;
					})
		)
		.join('');
}

export function relativeTime(value) {
	const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
	if (minutes < 1) return '방금 전';
	if (minutes < 60) return `${minutes}분 전`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
	return `${Math.floor(minutes / 1440)}일 전`;
}

export function docUrl(doc) {
	return doc.isDraft ? `/drafts?open=${doc.id}` : `/wiki/${encodeURIComponent(doc.slug)}`;
}

export function searchCatalog(catalog, query, field = '') {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return [];
	return catalog
		.map((doc) => {
			const title = doc.title.toLocaleLowerCase();
			const aliases = (doc.aliases || []).join(' ').toLocaleLowerCase();
			const haystack = `${title} ${aliases} ${doc.description} ${doc.content}`.toLocaleLowerCase();
			const score = terms.every((term) => haystack.includes(term))
				? (title === query.toLocaleLowerCase() ? 100 : 0) +
					terms.reduce(
						(sum, term) => sum + (title.includes(term) ? 10 : aliases.includes(term) ? 5 : 1),
						0
					)
				: 0;
			return { ...doc, score };
		})
		.filter((doc) => doc.score && (!field || doc.field === field))
		.sort(
			(a, b) =>
				b.score - a.score ||
				Number(a.isDraft) - Number(b.isDraft) ||
				Number(b.views || 0) - Number(a.views || 0)
		);
}
