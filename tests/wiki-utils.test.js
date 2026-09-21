import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog, wikiTargets, slugify, excerpt, docUrl } from '../src/lib/wiki-utils.js';
import { validHandle, regexGovernance } from '../src/lib/server/governance.js';
import { parseUpload, MAX_UPLOAD_BYTES } from '../src/lib/server/parser.js';
import JSZip from 'jszip';

test('search ranks title and aliases, matches all words and applies fields', () => {
	const catalog = [
		{
			title: 'RFCC',
			content: '정유 공정',
			aliases: ['잔사유 유동층 접촉분해'],
			field: '공정',
			isDraft: false
		},
		{ title: '촉매재생탑', content: 'RFCC 연결 설비', field: '설비', isDraft: false }
	];
	assert.equal(searchCatalog(catalog, 'rfcc')[0].title, 'RFCC');
	assert.equal(searchCatalog(catalog, '잔사유 접촉분해')[0].title, 'RFCC');
	assert.equal(searchCatalog(catalog, 'rfcc', '설비')[0].title, '촉매재생탑');
	assert.equal(searchCatalog(catalog, '없는 용어').length, 0);
	assert.equal(searchCatalog(catalog, '  ').length, 0);
});
test('wiki links keep Korean targets, aliases, duplicate and missing-link semantics', () => {
	assert.deepEqual(wikiTargets('[[RFCC]] [[산단스팀|스팀]] [[RFCC]]'), ['RFCC', '산단스팀']);
	assert.equal(slugify('교대 인수인계'), '교대-인수인계');
	assert.equal(excerpt('## 정의\n\n[[RFCC|공정]] 설명'), '정의 공정 설명');
	assert.equal(docUrl({ isDraft: true, id: 9 }), '/drafts?open=9');
});
test('prototype numeric operator handles work without admitting real names', () => {
	for (const handle of ['Operator-07', 'Operator-A', 'Editor-01'])
		assert.equal(validHandle(handle), true);
	for (const handle of ['홍길동', 'Operator-7', '']) assert.equal(validHandle(handle), false);
	assert.equal(regexGovernance('연락처 010-1234-5678').passed, false);
	assert.equal(regexGovernance('공정의 개요를 설명합니다.').passed, true);
});
test('PPTX extracts text in numeric slide order and decodes XML entities', async () => {
	const zip = new JSZip();
	zip.file('ppt/slides/slide10.xml', '<a:t>마지막 슬라이드</a:t>');
	zip.file('ppt/slides/slide2.xml', '<a:t>장비 &amp; 점검</a:t><a:t>[[위키 링크]]</a:t>');
	const text = await parseUpload(
		new File([await zip.generateAsync({ type: 'uint8array' })], 'sample.pptx')
	);
	assert.ok(text.indexOf('장비 & 점검') < text.indexOf('마지막 슬라이드'));
	assert.ok(text.includes('[[위키 링크]]'));
});
test('unsupported and oversized uploads fail before conversion', async () => {
	await assert.rejects(() => parseUpload(new File(['text'], 'sample.txt')), /DOCX, PDF, PPTX/);
	await assert.rejects(() => parseUpload({ size: MAX_UPLOAD_BYTES + 1 }), /40MB/);
});

test('automatic links preserve existing links and code while handling Korean particles', async () => {
	const { linkTerms } = await import('../src/lib/wiki-utils.js');
	assert.equal(
		linkTerms('산단스팀을 확인하고 RFCC 상태를 봅니다. `RFCC` [[RFCC]]', ['산단스팀', 'RFCC']),
		'[[산단스팀]]을 확인하고 RFCC 상태를 봅니다. `RFCC` [[RFCC]]'
	);
	assert.deepEqual(
		wikiTargets('[[https://example.com|출처]] [[파일:사진]] [[분류:설비]] [[RFCC]]'),
		['RFCC']
	);
});

test('text PDF extraction returns the page content', async () => {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	const content = 'BT /F1 12 Tf 72 720 Td (Wiki Viki document review) Tj ET';
	objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const start = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
		.join(
			'\n'
		)}\ntrailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF`;
	assert.match(
		await parseUpload(new File([pdf], 'review.pdf', { type: 'application/pdf' })),
		/Wiki Viki document review/
	);
});

test('image-only PPTX cannot create a misleading empty-text draft', async () => {
	const zip = new JSZip();
	zip.file(
		'ppt/slides/slide1.xml',
		'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
	);
	assert.equal(
		await parseUpload(new File([await zip.generateAsync({ type: 'uint8array' })], 'image.pptx')),
		''
	);
});
