import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { parseUploadDetailed } from '../src/lib/server/parser.js';

test('XLSX preserves workbook order, empty columns, cached formulas and dates', async () => {
	const zip = new JSZip();
	const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
	zip.file(
		'xl/workbook.xml',
		`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="먼저" sheetId="2" r:id="r2"/><sheet name="나중" sheetId="1" r:id="r1"/><sheet name="빈 시트" sheetId="3" r:id="r3"/></sheets></workbook>`
	);
	zip.file(
		'xl/_rels/workbook.xml.rels',
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3].map((i) => `<Relationship Id="r${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}</Relationships>`
	);
	zip.file(
		'xl/styles.xml',
		`<styleSheet xmlns="${ns}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`
	);
	zip.file(
		'xl/worksheets/sheet2.xml',
		`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>항목</t></is></c><c r="C1" t="inlineStr"><is><t>값</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><f>A2+2</f><v>3</v></c><c r="C2" s="1"><v>45292</v></c></row></sheetData></worksheet>`
	);
	zip.file(
		'xl/worksheets/sheet1.xml',
		`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>두번째 내용</t></is></c></row></sheetData></worksheet>`
	);
	zip.file('xl/worksheets/sheet3.xml', `<worksheet xmlns="${ns}"><sheetData/></worksheet>`);
	const { text, segments } = await parseUploadDetailed(
		new File([await zip.generateAsync({ type: 'uint8array' })], 'fixture.xlsx')
	);
	assert.ok(text.indexOf('먼저') < text.indexOf('나중'));
	assert.match(text, /항목\t\t값/);
	assert.match(text, /1\t3\t2024-01-01/);
	assert.ok(!text.includes('빈 시트'));
	assert.deepEqual(
		segments.map((s) => [s.kind, s.label, s.position]),
		[
			['sheet', '시트: 먼저', null],
			['sheet', '시트: 나중', null]
		]
	);
});
