export const mapDocuments = [
	{
		id: '1',
		slug: 'root',
		title: '가운데 지식',
		content: '[[branch]] ' + Array.from({ length: 7 }, (_, i) => `[[leaf-${i + 1}]]`).join(' ')
	},
	{ id: '2', slug: 'branch', title: '나뭇가지 지식', content: '[[root]] [[old-name]] [[deep]]' },
	{ id: '3', slug: 'deep', title: '깊은 지식', content: '[[final]]' },
	{ id: '4', slug: 'final', title: '끝 지식', content: '끝 지식의 본문' },
	{ id: '5', slug: 'standalone', title: '독립 지식', content: '연결 없는 본문' },
	...Array.from({ length: 7 }, (_, i) => ({
		id: String(i + 6),
		slug: `leaf-${i + 1}`,
		title: `이웃 ${i + 1}`,
		content: '[[root]]'
	}))
];
export const mapAliases = [{ alias_slug: 'old-name', alias_title: '이전 이름', document_id: '3' }];
