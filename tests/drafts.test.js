import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraftDocuments, linkTerms } from '../src/lib/knowledge.js';

test('multi-document drafts require unique usable titles and complete sections', () => {
	const draft = {
		title: '장비 인계',
		sections: [{ heading: '정의', content: '설명' }],
		suggestedLinks: [],
		aliases: []
	};
	assert.equal(validateDraftDocuments([draft])[0].slug, '장비-인계');
	assert.throws(() => validateDraftDocuments([draft, draft]));
	assert.throws(() => validateDraftDocuments([]));
	assert.throws(() => validateDraftDocuments([{ ...draft, sections: [] }]));
});

test('draft terms link Korean particles without corrupting existing links or code', () => {
	const text = '장비 인계는 기록합니다. `교대 점검` [[교대 점검|체크리스트]] [장비 인계](/wiki/a)';
	assert.equal(
		linkTerms(text, ['장비 인계', '교대 점검']),
		'[[장비 인계]]는 기록합니다. `교대 점검` [[교대 점검|체크리스트]] [장비 인계](/wiki/a)'
	);
	assert.equal(
		linkTerms('스팀 헤더는 스팀을 분배합니다.', ['스팀', '스팀 헤더']),
		'[[스팀 헤더]]는 [[스팀]]을 분배합니다.'
	);
});
