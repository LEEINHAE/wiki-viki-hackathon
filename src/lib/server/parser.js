import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export async function parseUpload(file) {
	const bytes = Buffer.from(await file.arrayBuffer());
	const name = file.name || 'upload';
	if (/\.docx$/i.test(name) || file.type.includes('wordprocessingml')) {
		const result = await mammoth.extractRawText({ buffer: bytes });
		return result.value.trim();
	}
	if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
		const parser = new PDFParse({ data: bytes });
		try {
			const result = await parser.getText();
			return result.text.trim();
		} finally {
			await parser.destroy();
		}
	}
	throw new Error('DOCX와 텍스트 기반 PDF 파일만 지원합니다.');
}
