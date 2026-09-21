import mammoth from 'mammoth';
import readExcelFile from 'read-excel-file/node';
import { extractPresentation } from './presentation.js';
import { uploadFormatMessage } from '../upload.js';

export async function parseUpload(file) {
	const bytes = Buffer.from(await file.arrayBuffer());
	const name = file.name || 'upload';
	if (/\.xlsx$/i.test(name)) {
		const sheets = await readExcelFile(bytes);
		return sheets
			.map(({ sheet, data }) => {
				const rows = data
					.filter((row) => row.some((value) => value !== null && value !== ''))
					.map((row) =>
						row
							.map((value) => (value instanceof Date ? value.toISOString() : String(value ?? '')))
							.join('\t')
					);
				return rows.length ? `## 시트: ${sheet}\n\n${rows.join('\n')}` : '';
			})
			.filter(Boolean)
			.join('\n\n')
			.trim();
	}
	if (/\.pptx$/i.test(name)) return extractPresentation(bytes);
	if (/\.docx$/i.test(name) || file.type.includes('wordprocessingml')) {
		const result = await mammoth.extractRawText({ buffer: bytes });
		return result.value.trim();
	}
	if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
		// Load the Node canvas polyfills before PDF.js, only for PDF uploads.
		// The explicit worker import also lets Vercel trace its native dependencies.
		const { CanvasFactory, getData } = await import('pdf-parse/worker');
		const { PDFParse } = await import('pdf-parse');
		PDFParse.setWorker(getData());
		const parser = new PDFParse({ data: bytes, CanvasFactory });
		try {
			const result = await parser.getText();
			return result.text.trim();
		} finally {
			await parser.destroy();
		}
	}
	throw new Error(uploadFormatMessage);
}
