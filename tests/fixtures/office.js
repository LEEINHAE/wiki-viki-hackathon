import JSZip from 'jszip';

const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function archive(type) {
	const zip = new JSZip();
	zip.file(
		'[Content_Types].xml',
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${type === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'}" ContentType="application/vnd.openxmlformats-officedocument.${type === 'xlsx' ? 'spreadsheetml.sheet' : 'presentationml.presentation'}.main+xml"/></Types>`
	);
	zip.file(
		'_rels/.rels',
		`<Relationships xmlns="${packageRelationships}"><Relationship Id="root" Type="${relationships}/officeDocument" Target="${type === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'}"/></Relationships>`
	);
	return zip;
}

export async function workbookFile({ empty = false } = {}) {
	const zip = archive('xlsx');
	zip.file(
		'xl/workbook.xml',
		`<workbook xmlns="${spreadsheet}" xmlns:r="${relationships}"><sheets><sheet name="업무 용어" sheetId="2" r:id="second"/><sheet name="점검표" sheetId="1" r:id="first"/></sheets></workbook>`
	);
	zip.file(
		'xl/_rels/workbook.xml.rels',
		`<Relationships xmlns="${packageRelationships}"><Relationship Id="first" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="second" Type="${relationships}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="strings" Type="${relationships}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="styles" Type="${relationships}/styles" Target="styles.xml"/></Relationships>`
	);
	zip.file(
		'xl/sharedStrings.xml',
		`<sst xmlns="${spreadsheet}"><si><r><t>인계 </t></r><r><t>노트</t></r></si></sst>`
	);
	zip.file(
		'xl/styles.xml',
		`<styleSheet xmlns="${spreadsheet}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`
	);
	zip.file(
		'xl/worksheets/sheet2.xml',
		`<worksheet xmlns="${spreadsheet}"><sheetData>${empty ? '' : '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>다음 근무자에게 작업 상태를 전하는 예시 기록</t></is></c></row><row r="2"><c r="A2"><v>0</v></c><c r="B2" t="b"><v>0</v></c><c r="C2"><f>2+3</f><v>5</v></c><c r="D2" s="1"><v>45292</v></c></row>'}</sheetData></worksheet>`
	);
	zip.file(
		'xl/worksheets/sheet1.xml',
		`<worksheet xmlns="${spreadsheet}"><sheetData>${empty ? '' : '<row r="1"><c r="A1" t="inlineStr"><is><t>공용 장비 점검표</t></is></c><c r="B1" t="inlineStr"><is><t>장비 수량 &amp; 위치를 확인하는 예시 양식</t></is></c></row>'}</sheetData></worksheet>`
	);
	return new File([await zip.generateAsync({ type: 'nodebuffer' })], 'office-verification.xlsx');
}

export async function presentationFile({ empty = false } = {}) {
	const zip = archive('pptx');
	zip.file(
		'ppt/presentation.xml',
		`<p:presentation xmlns:p="${presentation}" xmlns:r="${relationships}"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>`
	);
	zip.file(
		'ppt/_rels/presentation.xml.rels',
		`<Relationships xmlns="${packageRelationships}"><Relationship Id="first" Type="${relationships}/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="${relationships}/slide" Target="slides/slide10.xml"/></Relationships>`
	);
	zip.file(
		'ppt/slides/slide10.xml',
		`<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree>${empty ? '' : '<p:sp><p:txBody><a:p><a:r><a:t>인계 </a:t></a:r><a:r><a:t>노트</a:t></a:r><a:br/><a:r><a:t>다음 근무자에게 작업 상태를 전하는 예시 기록</a:t></a:r></a:p></p:txBody></p:sp>'}</p:spTree></p:cSld></p:sld>`
	);
	zip.file(
		'ppt/slides/slide1.xml',
		`<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree>${empty ? '' : '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>공용 장비 점검표</a:t></a:r></a:p><a:p><a:r><a:t>장비 수량 &amp; 위치를 확인하는 예시 양식</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'}</p:spTree></p:cSld></p:sld>`
	);
	return new File([await zip.generateAsync({ type: 'nodebuffer' })], 'office-verification.pptx');
}
