import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import JSZip from 'jszip';

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_TEXT = 120000;
function xmlText(xml) {
	return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
		.map((match) =>
			match[1]
				.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
				.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
				.replaceAll('&lt;', '<')
				.replaceAll('&gt;', '>')
				.replaceAll('&quot;', '"')
				.replaceAll('&apos;', "'")
				.replaceAll('&amp;', '&')
		)
		.join('\n');
}
export async function parseUpload(file) {
	if (file.size > MAX_UPLOAD_BYTES) throw new Error('파일 크기는 40MB 이하여야 합니다.');
	const bytes = Buffer.from(await file.arrayBuffer());
	const name = file.name || 'upload';
	let text;
	if (/\.(docx|pptx)$/i.test(name)) {
		const zip = await JSZip.loadAsync(bytes);
		const unpacked = Object.values(zip.files).reduce(
			(total, entry) => total + (entry._data?.uncompressedSize || 0),
			0
		);
		if (unpacked > 150 * 1024 * 1024)
			throw new Error('압축을 푼 문서가 너무 큽니다. 문서를 나누어 올려 주세요.');
		if (/\.docx$/i.test(name))
			text = (await mammoth.extractRawText({ buffer: bytes })).value.trim();
		else {
			const slides = Object.keys(zip.files)
				.filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
				.sort(
					(a, b) => Number(a.match(/slide(\d+)\.xml/)[1]) - Number(b.match(/slide(\d+)\.xml/)[1])
				);
			text = (
				await Promise.all(
					slides.map(async (path, index) => {
						const content = xmlText(await zip.file(path).async('string'));
						return content.trim() ? `## 슬라이드 ${index + 1}\n\n${content}` : '';
					})
				)
			)
				.filter(Boolean)
				.join('\n\n');
			if (!slides.length) throw new Error('슬라이드 내용을 찾을 수 없습니다.');
		}
	} else if (/\.pdf$/i.test(name)) {
		const parser = new PDFParse({ data: bytes });
		try {
			text = (await parser.getText()).text.trim();
		} finally {
			await parser.destroy();
		}
	} else throw new Error('DOCX, PDF, PPTX 파일만 지원합니다.');
	if (text.length > MAX_TEXT)
		throw new Error('문서의 텍스트가 너무 깁니다. 12만 자 이하로 나누어 올려 주세요.');
	return text;
}
