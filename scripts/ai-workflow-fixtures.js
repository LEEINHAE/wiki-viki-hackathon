import JSZip from 'jszip';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (value) =>
	value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const paragraphs = (format) => [
	`합성 테스트 자료 ${format}. 실제 업무 절차가 아닙니다. 서로 구분되는 아래 두 개념을 설명합니다.`,
	`${format} 파랑카드`,
	`${format} 파랑카드는 가상 학습 도구의 대여 상태를 나타냅니다. 빌릴 때 카드에 도구 이름을 기록하고 도구와 함께 둡니다. 반납 후 카드와 도구를 파란 보관함에 넣습니다.`,
	`${format} 초록점검표`,
	`${format} 초록점검표는 가상 학습 도구의 준비 상태를 확인합니다. 도구 개수와 부속품을 확인한 뒤 완료 표시를 합니다. 이상이 있으면 사용을 멈추고 담당 검토자에게 알려 줍니다.`
];
export async function workflowFixtures() {
	const files = [];
	const docx = new JSZip();
	docx.file(
		'[Content_Types].xml',
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
	);
	docx.file(
		'_rels/.rels',
		`<Relationships xmlns="${packageRel}"><Relationship Id="r1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`
	);
	docx.file(
		'word/document.xml',
		`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs(
			'DOCX'
		)
			.map((p) => `<w:p><w:r><w:t>${xml(p)}</w:t></w:r></w:p>`)
			.join('')}</w:body></w:document>`
	);
	files.push(new File([await docx.generateAsync({ type: 'uint8array' })], 'synthetic-docx.docx'));
	const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
	const xlsx = new JSZip();
	xlsx.file(
		'xl/workbook.xml',
		`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="학습 도구" sheetId="1" r:id="r1"/></sheets></workbook>`
	);
	xlsx.file(
		'xl/_rels/workbook.xml.rels',
		`<Relationships xmlns="${packageRel}"><Relationship Id="r1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
	);
	xlsx.file(
		'xl/worksheets/sheet1.xml',
		`<worksheet xmlns="${ns}"><sheetData>${paragraphs('XLSX')
			.map(
				(p, i) =>
					`<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${xml(p)}</t></is></c></row>`
			)
			.join('')}</sheetData></worksheet>`
	);
	files.push(new File([await xlsx.generateAsync({ type: 'uint8array' })], 'synthetic-xlsx.xlsx'));
	const pptx = new JSZip();
	pptx.file(
		'ppt/presentation.xml',
		`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${rel}"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>`
	);
	pptx.file(
		'ppt/_rels/presentation.xml.rels',
		`<Relationships xmlns="${packageRel}"><Relationship Id="r1" Type="${rel}/slide" Target="slides/slide1.xml"/></Relationships>`
	);
	pptx.file(
		'ppt/slides/slide1.xml',
		`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs(
			'PPTX'
		)
			.map((p) => `<a:p><a:r><a:t>${xml(p)}</a:t></a:r></a:p>`)
			.join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
	);
	files.push(new File([await pptx.generateAsync({ type: 'uint8array' })], 'synthetic-pptx.pptx'));
	const lines = [
		'Synthetic PDF test material. These are fictional learning tools.',
		'PDF Bluecard: records the borrowing status of a learning tool.',
		'Write the tool name on the card and keep them together.',
		'After return, put the card and tool in the blue storage box.',
		'PDF Greenchecklist: checks readiness before using a learning tool.',
		'Check the tool count and accessories, then mark completion.',
		'If a problem is found, stop use and tell the assigned reviewer.'
	];
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	const content = `BT /F1 10 Tf 40 740 Td 16 TL ${lines.map((l, i) => `${i ? 'T* ' : ''}(${l}) Tj`).join('\n')} ET`;
	objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	let pdf = '%PDF-1.4\n';
	const offsets = [];
	for (const [i, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	}
	const start = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF`;
	files.push(new File([pdf], 'synthetic-pdf.pdf'));
	return files;
}
