import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpload } from '../src/lib/server/parser.js';
import { supportsUpload } from '../src/lib/upload.js';
import { workbookFile, presentationFile } from './fixtures/office.js';
import { seedPdf } from './fixtures/seed-source.js';

test('PDF loads its Node canvas and worker before extracting text, including subsequent uploads', async () => {
	for (const text of ['First PDF upload', 'Second PDF upload']) {
		const extracted = await parseUpload(new File([seedPdf(text)], 'verification.pdf'));
		assert.ok(extracted.includes(text));
	}
	await assert.rejects(parseUpload(new File(['invalid'], 'broken.pdf')));
	assert.ok((await parseUpload(await workbookFile())).includes('인계 노트'));
});

test('Excel retains sheet order, blank columns, rich strings, cached formulas and dates', async () => {
	const text = await parseUpload(await workbookFile());
	assert.ok(text.indexOf('시트: 업무 용어') < text.indexOf('시트: 점검표'));
	assert.ok(text.includes('인계 노트\t\t다음 근무자에게 작업 상태를 전하는 예시 기록'));
	assert.ok(text.includes('0\tfalse\t5\t2024-01-01T00:00:00.000Z'));
	assert.ok(text.includes('장비 수량 & 위치'));
});

test('PowerPoint follows presentation order and reads text runs, line breaks and tables', async () => {
	const text = await parseUpload(await presentationFile());
	assert.ok(text.startsWith('## 슬라이드 1\n\n인계 노트\n'));
	assert.ok(text.includes('## 슬라이드 2\n\n공용 장비 점검표\n장비 수량 & 위치'));
});

test('empty spreadsheets and text-free presentations do not produce heading-only content', async () => {
	assert.equal(await parseUpload(await workbookFile({ empty: true })), '');
	assert.equal(await parseUpload(await presentationFile({ empty: true })), '');
});

test('invalid archives fail and legacy Office formats are not silently accepted', async () => {
	for (const extension of ['xlsx', 'pptx']) {
		assert.ok(supportsUpload(`FILE.${extension.toUpperCase()}`));
		await assert.rejects(parseUpload(new File(['invalid'], `bad.${extension}`)));
	}
	for (const extension of ['xls', 'ppt', 'xlsm', 'exe']) {
		assert.equal(supportsUpload(`file.${extension}`), false);
	}
});
