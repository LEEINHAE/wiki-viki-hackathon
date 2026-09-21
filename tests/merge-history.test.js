import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { regexGovernance } from '../src/lib/content-guard.js';
import {
	mergeHistory,
	parseMergeHistory,
	mergeHistoryPrefix,
	mergeHistoryInspection
} from '../src/lib/merge-history.js';

const draft = { id: '9007199254740993', title: '새 점검', source_name: '공개 예제.docx' };
const proposal = {
	id: randomUUID(),
	content: '3일\n[[보관]]',
	summary: '주기 변경',
	conflicts: [{ topic: '주기', previous: '7일', incoming: '3일' }]
};

test('merge history retains source, conflicts, exact BIGINT and manual-edit evidence', () => {
	const summary = mergeHistory(draft, proposal, '3일\r\n[[보관]]');
	assert.ok(summary.startsWith(mergeHistoryPrefix));
	assert.deepEqual(parseMergeHistory(summary), {
		schemaVersion: 1,
		proposalId: proposal.id,
		draftId: draft.id,
		draftTitle: draft.title,
		sourceName: draft.source_name,
		summary: proposal.summary,
		conflicts: proposal.conflicts,
		manuallyEdited: false
	});
	assert.equal(
		parseMergeHistory(mergeHistory(draft, proposal, proposal.content + '\n추가 주의'))
			.manuallyEdited,
		true
	);
	assert.equal(
		parseMergeHistory(
			mergeHistory(
				{ ...draft, source_name: null },
				{ ...proposal, conflicts: [] },
				proposal.content
			)
		).sourceName,
		null
	);
});

test('normal, incomplete and malformed historical summaries are not mislabelled as AI merges', () => {
	const record = parseMergeHistory(mergeHistory(draft, proposal, proposal.content));
	for (const summary of [
		'',
		'이전 편집',
		'[AI 통합 · 새 초안 우선] 일반 메모',
		mergeHistoryPrefix + '{',
		mergeHistoryPrefix + 'null',
		mergeHistoryPrefix + '[]'
	])
		assert.equal(parseMergeHistory(summary), null);
	for (const patch of [
		{ schemaVersion: 2 },
		{ proposalId: 'unknown' },
		{ draftId: '9223372036854775808' },
		{ draftId: 3 },
		{ draftTitle: null },
		{ sourceName: {} },
		{ manuallyEdited: 'false' },
		{ conflicts: [{ topic: '주기', existing: '7일', incoming: '3일' }] },
		{ summary: 'x'.repeat(2001) }
	])
		assert.equal(
			parseMergeHistory(mergeHistoryPrefix + JSON.stringify({ ...record, ...patch })),
			null
		);
});

test('merge inspection excludes machine identifiers while retaining every displayed text field', () => {
	const inputDraft = { ...draft, id: '1012345678' },
		inputProposal = { ...proposal, id: 'a0101234-5678-4abc-8abc-abcdefabcdef' };
	const summary = mergeHistory(inputDraft, inputProposal, inputProposal.content);
	assert.equal(regexGovernance(summary).passed, true);
	const text = mergeHistoryInspection(summary);
	assert.equal(regexGovernance(text).passed, true);
	assert.ok(!text.includes(inputDraft.id));
	assert.ok(!text.includes(inputProposal.id));
	for (const value of [
		inputDraft.title,
		inputDraft.source_name,
		inputProposal.summary,
		...inputProposal.conflicts.flatMap((c) => [c.topic, c.previous, c.incoming])
	])
		assert.ok(text.includes(value));
	assert.equal(parseMergeHistory(summary).proposalId, inputProposal.id);
	assert.equal(parseMergeHistory(summary).draftId, inputDraft.id);
	for (const bad of ['', mergeHistoryPrefix + '{', mergeHistoryPrefix + 'null'])
		assert.throws(() => mergeHistoryInspection(bad), /Invalid merge history/);
});

test('credentials in human history fields still trigger the shared local protection', () => {
	const record = parseMergeHistory(mergeHistory(draft, proposal, proposal.content));
	const contact = 'password=NotARealSecret42!';
	for (const field of ['draftTitle', 'sourceName', 'summary']) {
		const summary = mergeHistoryPrefix + JSON.stringify({ ...record, [field]: contact });
		assert.equal(regexGovernance(mergeHistoryInspection(summary)).passed, false, field);
	}
	for (const field of ['topic', 'previous', 'incoming']) {
		const summary =
			mergeHistoryPrefix +
			JSON.stringify({ ...record, conflicts: [{ ...record.conflicts[0], [field]: contact }] });
		assert.equal(regexGovernance(mergeHistoryInspection(summary)).passed, false, field);
	}
});
