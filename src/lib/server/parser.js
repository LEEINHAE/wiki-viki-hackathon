import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import JSZip from 'jszip';
import readExcel from 'read-excel-file/node';
import { DOMParser } from '@xmldom/xmldom';
import { posix } from 'node:path';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 120000;
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export class UploadError extends Error {
	constructor(message) {
		super(message);
		this.name = 'UploadError';
	}
}
function xml(source) {
	if (/<!DOCTYPE|<!ENTITY/i.test(source))
		throw new UploadError('외부 참조가 포함된 문서는 지원하지 않습니다.');
	return new DOMParser({
		onError: () => {
			throw new UploadError('문서의 XML 구조를 읽을 수 없습니다.');
		}
	}).parseFromString(source, 'text/xml');
}
async function readXml(zip, path) {
	const file = zip.file(path);
	if (!file)
		throw new UploadError('문서의 구성 파일을 찾을 수 없습니다. 다시 저장한 뒤 올려 주세요.');
	return xml(await file.async('string'));
}
function paragraphText(node) {
	let text = '';
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.namespaceURI === A && child.localName === 't') text += child.textContent;
		else if (child.namespaceURI === A && child.localName === 'br') text += '\n';
		else if (child.namespaceURI === A && child.localName === 'tab') text += '\t';
		else text += paragraphText(child);
	}
	return text;
}
async function extractSlides(zip) {
	const presentation = await readXml(zip, 'ppt/presentation.xml');
	const relationships = await readXml(zip, 'ppt/_rels/presentation.xml.rels');
	const byId = new Map(
		Array.from(relationships.getElementsByTagName('Relationship'))
			.filter(
				(r) =>
					r.getAttribute('TargetMode') !== 'External' && r.getAttribute('Type').endsWith('/slide')
			)
			.map((r) => [r.getAttribute('Id'), r.getAttribute('Target')])
	);
	const slides = Array.from(presentation.getElementsByTagNameNS(P, 'sldId'));
	if (!slides.length) return [];
	const sections = [];
	for (let index = 0; index < slides.length; index++) {
		const target = byId.get(slides[index].getAttributeNS(R, 'id'));
		if (!target) throw new UploadError('슬라이드 연결을 읽을 수 없습니다.');
		const path = posix.normalize(
			target.startsWith('/') ? target.slice(1) : posix.join('ppt', target)
		);
		if (!path.startsWith('ppt/slides/') || !path.endsWith('.xml'))
			throw new UploadError('잘못된 슬라이드 경로입니다.');
		const doc = await readXml(zip, path);
		const text = Array.from(doc.getElementsByTagNameNS(A, 'p'))
			.map(paragraphText)
			.filter((p) => p.trim())
			.join('\n');
		if (text.trim())
			sections.push({ kind: 'slide', position: index + 1, label: `슬라이드 ${index + 1}`, text });
	}
	return sections;
}
export async function parseUploadDetailed(file) {
	if (file.size > MAX_UPLOAD_BYTES) throw new UploadError('파일 크기는 10MB 이하여야 합니다.');
	if (!file.size) throw new UploadError('빈 파일은 처리할 수 없습니다.');
	const name = file.name || 'upload';
	if (!/\.(docx|pdf|xlsx|pptx)$/i.test(name))
		throw new UploadError('DOCX, PDF, XLSX, PPTX 파일만 지원합니다.');
	const bytes = Buffer.from(await file.arrayBuffer());
	let text = '';
	let segments = [];
	try {
		if (/\.(docx|xlsx|pptx)$/i.test(name)) {
			const zip = await JSZip.loadAsync(bytes);
			const entries = Object.values(zip.files);
			if (
				entries.length > 20000 ||
				entries.reduce((total, entry) => total + (entry._data?.uncompressedSize || 0), 0) >
					150 * 1024 * 1024
			)
				throw new UploadError('압축을 푼 문서가 너무 큽니다. 문서를 나누어 올려 주세요.');
			if (/\.docx$/i.test(name))
				text = (await mammoth.extractRawText({ buffer: bytes })).value.trim();
			else if (/\.pptx$/i.test(name)) {
				segments = await extractSlides(zip);
				text = segments.map((s) => `## ${s.label}\n\n${s.text}`).join('\n\n');
			} else {
				const sheets = await readExcel(bytes);
				segments = sheets
					.map(({ sheet, data }) => {
						const lines = data
							.map((row) =>
								row
									.map((cell) =>
										cell instanceof Date ? cell.toISOString() : cell == null ? '' : String(cell)
									)
									.join('\t')
							)
							.filter((row) => row.trim());
						return lines.length
							? { kind: 'sheet', position: null, label: `시트: ${sheet}`, text: lines.join('\n') }
							: null;
					})
					.filter(Boolean);
				text = segments.map((s) => `## ${s.label}\n\n${s.text}`).join('\n\n');
			}
		} else {
			const parser = new PDFParse({ data: bytes });
			try {
				const result = await parser.getText();
				segments = result.pages
					.filter((p) => p.text.trim())
					.map((p) => ({
						kind: 'page',
						position: p.num,
						label: `페이지 ${p.num}`,
						text: p.text.trim()
					}));
				// The aggregate result adds synthetic page separators, including for
				// empty pages. Send only text that is also present in the source viewer.
				text = segments.map((segment) => segment.text).join('\n\n');
			} finally {
				await parser.destroy();
			}
		}
	} catch (cause) {
		if (cause instanceof UploadError) throw cause;
		throw new UploadError(
			'파일을 읽을 수 없습니다. 암호를 해제하고 지원 형식으로 다시 저장한 뒤 올려 주세요.'
		);
	}
	if (text.length > MAX_TEXT)
		throw new UploadError('문서의 텍스트가 너무 깁니다. 12만 자 이하로 나누어 올려 주세요.');
	if (!segments.length && text.trim())
		segments = text
			.split(/\n\s*\n/)
			.filter((s) => s.trim())
			.map((text, index) => ({
				kind: 'paragraph',
				position: index + 1,
				label: `추출 문단 ${index + 1}`,
				text: text.trim()
			}));
	return { text, segments };
}
export async function parseUpload(file) {
	return (await parseUploadDetailed(file)).text;
}
