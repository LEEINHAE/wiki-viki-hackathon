<script>
	import StatusNotice from './StatusNotice.svelte';
	import WikiEditor from './WikiEditor.svelte';
	import { normalizeMergeText } from '$lib/merge-history.js';
	let {
		proposal,
		finalContent = $bindable(''),
		mergeEditor = $bindable(''),
		saving = false,
		disabled = false,
		draftId,
		action = '',
		semanticAvailable = true,
		governance = null
	} = $props();
	let confirmMerge = $state(false);
	$effect(() => {
		finalContent;
		mergeEditor;
		proposal.id;
		confirmMerge = false;
	});
</script>

<section aria-label="AI 통합안 검토">
	<h2>AI 통합안 검토</h2>
	{#if proposal.invalid}
		<StatusNotice tone="warning" role="status">
			저장된 통합안의 형식을 확인할 수 없습니다. 다시 생성해 주세요.
		</StatusNotice>
	{:else}
		{#if proposal.stale}<StatusNotice tone="warning" role="status">
				초안 또는 대상 문서가 변경되어 오래된 통합안입니다. 최신 상태에서 다시 생성해 주세요.
			</StatusNotice>{/if}
		<p>
			대상: <a href={'/wiki/' + encodeURIComponent(proposal.targetSlug)}>{proposal.targetTitle}</a>
		</p>
		<h3>변경 요약</h3>
		<p class="preserve-lines">{proposal.summary}</p>
		<h3>상충 항목 · 새 초안 우선</h3>
		<p class="small muted">
			AI가 상충을 놓칠 수 있습니다. 기존 정보·출처·주의 사항도 함께 확인하세요.
		</p>
		{#each proposal.conflicts as conflict}
			<div class="conflict">
				<h4>{conflict.topic}</h4>
				<p class="preserve-lines"><strong>기존 내용:</strong> {conflict.previous}</p>
				<p class="preserve-lines"><strong>새 초안 내용:</strong> {conflict.incoming}</p>
			</div>
		{:else}<p>AI가 반환한 상충 항목이 없습니다.</p>{/each}
		<details open>
			<summary>기존 본문과 AI 원안 차이</summary>
			<p class="small muted">
				추가와 삭제를 표시합니다. 비교 기준은 생성 당시 기존 본문과 AI 원안입니다.
			</p>
			{#if proposal.diff}
				<div
					class="diff-box"
					tabindex="0"
					role="textbox"
					aria-readonly="true"
					aria-multiline="true"
					aria-label="AI 원안 차이"
				>
					{#each proposal.diff as part}<span
							class:diff-add={part.added}
							class:diff-remove={part.removed}
							>{part.added ? '[추가] ' : part.removed ? '[삭제] ' : ''}{part.value}</span
						>{/each}
				</div>
			{:else}
				<p>차이가 커서 두 본문을 각각 표시합니다.</p>
				<label for="merge-original">생성 당시 기존 본문</label><textarea
					id="merge-original"
					readonly>{proposal.originalContent}</textarea
				>
			{/if}
		</details>
		<div class="field">
			<label for="merge-content">AI 통합 원안</label><textarea
				id="merge-content"
				class="ai-original"
				readonly>{proposal.content}</textarea
			>
		</div>
		<WikiEditor
			bind:content={finalContent}
			title={proposal.targetTitle}
			inputId="final-content"
			name="finalContent"
			label="최종 통합 본문"
			previewLabel="현재 최종 통합 미리보기"
			baselineLabel="AI 통합 원안 기준"
			required={false}
			ariaRequired={true}
			saved={true}
			dirty={normalizeMergeText(finalContent) !== normalizeMergeText(proposal.content)}
			unavailable={proposal.stale}
			disabled={saving}
			scope={`${draftId}:merge:${proposal.id}`}
			anchorPrefix={`draft-${draftId}-merge-`}
			draft={{ id: String(draftId), mode: 'merge', proposalId: proposal.id }}
		/>
		<p class="small muted">
			200,000자까지 입력할 수 있습니다. 위의 차이는 AI 원안 기준이며, 현재 최종 본문은 이
			미리보기에서 확인하세요.
		</p>
		<div class="field">
			<label for="merge-editor">통합 검토자 이름</label><input
				id="merge-editor"
				name="mergeEditor"
				bind:value={mergeEditor}
				disabled={saving}
				aria-required="true"
			/>
			<small>Editor-01 또는 Operator-A 형식의 익명 이름을 입력하세요.</small>
		</div>
		{#if governance && !governance.passed}<StatusNotice tone="warning" role="status">
				<p>최종 통합 입력의 검사 결과입니다. 저장된 초안과 통합안은 유지했습니다.</p>
				{#each [...governance.regex.reasons, ...governance.semantic.reasons] as reason}<p>
						{reason}
					</p>{/each}
			</StatusNotice>{/if}
		{#if !semanticAvailable}<StatusNotice tone="warning" role="status">
				AI 의미 기반 검사는 실행되지 않습니다. 저장된 통합안과 최종 본문을 직접 검토한 뒤 적용해
				주세요.
			</StatusNotice>{/if}
		<p>
			기존 문서의 제목·주소를 유지하고 최종 본문을 반영합니다. 다른 문서가 사용 중인 별칭은 추가하지
			않습니다.
		</p>
		<label class="merge-confirm"
			><input
				type="checkbox"
				name="confirmMerge"
				value="yes"
				bind:checked={confirmMerge}
				disabled={saving || disabled || proposal.stale}
			/> 최종 본문과 상충 내용을 검토했습니다.</label
		>
		<div class="button-row">
			<button
				class="primary-button"
				formaction={`?/applyMerge&open=${draftId}`}
				disabled={saving || disabled || proposal.stale}
			>
				{action === 'applyMerge' ? '검사 후 통합 중…' : '검토 완료 · 기존 문서에 통합'}</button
			>
		</div>
		{#if saving && action === 'applyMerge'}<StatusNotice tone="pending">
				최종 내용을 검사하고 기존 문서에 반영하고 있습니다.
			</StatusNotice>{/if}
	{/if}
</section>

<style>
	section {
		margin-top: 1.5rem;
	}
	.preserve-lines {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.conflict {
		padding: var(--inset-padding);
		border: 1px solid var(--line);
		border-radius: var(--inset-radius);
		margin: 0.75rem 0;
	}
	.diff-box {
		max-height: 28rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	details {
		margin: 1rem 0;
	}
	summary {
		cursor: pointer;
	}
	.merge-confirm {
		display: flex;
		align-items: start;
		gap: 0.5rem;
	}
	.merge-confirm input {
		margin-top: 0.3rem;
	}
	.ai-original {
		min-height: 8rem;
		max-height: 20rem;
	}
</style>
