<script>
	let { record } = $props();
</script>

<div class="merge-history">
	<span class="tag">AI 통합 · 새 초안 우선</span>
	<p>{record.summary}</p>
	<details>
		<summary>통합 상세 · 상충 {record.conflicts.length}개</summary>
		<p>초안 #{record.draftId}: {record.draftTitle}</p>
		<p>업로드 자료: {record.sourceName || '직접 작성'}</p>
		<p>
			{record.manuallyEdited
				? '검토자가 AI 원안을 추가 수정했습니다.'
				: 'AI 원안을 추가 수정하지 않고 적용했습니다.'}
		</p>
		<p class="small muted">최종 반영 본문은 이 리비전의 차이 보기에서 확인할 수 있습니다.</p>
		{#each record.conflicts as conflict}
			<div class="conflict">
				<strong>{conflict.topic}</strong>
				<p>기존 내용: {conflict.previous}</p>
				<p>새 초안 내용: {conflict.incoming}</p>
			</div>
		{:else}<p>AI가 반환한 상충 항목이 없습니다.</p>{/each}
	</details>
</div>

<style>
	.merge-history {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	p {
		white-space: pre-wrap;
	}
	summary {
		cursor: pointer;
	}
	.conflict {
		border-top: 1px solid var(--line);
		padding-top: 0.75rem;
		margin-top: 0.75rem;
	}
</style>
