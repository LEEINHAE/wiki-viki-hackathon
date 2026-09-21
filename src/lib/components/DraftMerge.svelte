<script>
	import ActorIdentity from '$lib/components/ActorIdentity.svelte';
	import { enhance } from '$app/forms';
	import { enhanceSave } from '$lib/enhance-save.js';
	import MarkdownEditor from './MarkdownEditor.svelte';
	import FormRecovery from './FormRecovery.svelte';
	let { draft, targets = [], changes = [], form, targetQuery = '' } = $props();
	const plan = $derived(draft.governance?.merge);
	let targetId = $state('');
	let content = $state('');
	let element = $state();
	let busy = $state(false);
	$effect(() => {
		draft.version;
		content = form?.mergeContent ?? plan?.content ?? '';
		busy = false;
		const recommended = targets.filter((t) => t.recommended);
		targetId = plan?.targetId ?? (recommended.length === 1 ? recommended[0].id : '');
	});
</script>

<section class="merge-workspace">
	<h2>기존 문서와 AI 통합</h2>
	<p>
		상충하는 내용은 새 초안을 우선합니다. 기존 문서의 고유 정보·출처가 유지되는지 확인한 뒤 적용해
		주세요.
	</p>
	<form method="GET" class="search-filters">
		<input type="hidden" name="open" value={draft.id} /><label
			>통합 대상 찾기 <input
				name="targetQ"
				value={targetQuery}
				maxlength="200"
				placeholder="제목 또는 별칭"
			/></label
		><button class="secondary-button">대상 검색</button>
	</form>
	<p class="muted">
		제목·별칭이 일치하는 후보를 먼저 보여 줍니다. 최대 50개이며 검색으로 좁힐 수 있습니다.
	</p>

	<form
		method="POST"
		action={`?/prepareMerge&open=${draft.id}`}
		onsubmit={() => (busy = true)}
		use:enhance={enhanceSave}
	>
		<input type="hidden" name="id" value={draft.id} /><input
			type="hidden"
			name="version"
			value={draft.version}
		/>
		<div class="field">
			<label for="merge-target">통합할 게시 문서</label><select
				id="merge-target"
				name="targetId"
				bind:value={targetId}
				required
				><option value="">문서를 선택해 주세요</option>{#each targets as target}<option
						value={target.id}>{target.recommended ? '추천 · ' : ''}{target.title}</option
					>{/each}</select
			>
		</div>
		<button class="secondary-button" disabled={busy || !targetId}
			>{busy ? '통합안 생성 중…' : plan ? '통합안 다시 생성' : 'AI 통합안 만들기'}</button
		>
	</form>
	{#if plan}
		<div class="notice">
			<strong>{plan.targetTitle} 통합안</strong>
			<p>{plan.summary}</p>
			<small>생성만으로 게시 문서가 바뀌지 않습니다.</small>
		</div>
		<h3>상충 항목 {plan.conflicts.length}개 · 새 초안 우선</h3>
		{#each plan.conflicts as conflict}<section class="conflict-item">
				<h4>{conflict.topic}</h4>
				<p class="diff-remove">기존 내용: {conflict.previous}</p>
				<p class="diff-add">새 초안: {conflict.incoming}</p>
			</section>{:else}<p>AI가 발견한 상충 항목이 없습니다. 원문을 직접 확인해 주세요.</p>{/each}
		<details>
			<summary>기존 본문과 AI 통합안 비교</summary>
			<p>추가: 올리브 · 삭제: 주황색 취소선. 아래에서 수동 수정하기 전의 AI 통합안 기준입니다.</p>
			<div class="diff-box">
				{#each changes as part}<span class:diff-add={part.added} class:diff-remove={part.removed}
						>{part.value}</span
					>{/each}
			</div>
		</details>
		<form
			method="POST"
			action={`?/applyMerge&open=${draft.id}`}
			bind:this={element}
			use:enhance={enhanceSave}
		>
			<input type="hidden" name="id" value={draft.id} /><input
				type="hidden"
				name="version"
				value={form?.version ?? draft.version}
			/><input type="hidden" name="mergeId" value={plan.id} />
			<FormRecovery
				{element}
				storageKey={`merge:${draft.id}:${plan.id}`}
				kind="draft"
				resources={[{ type: 'draft', id: draft.id }]}
			/>
			<div class="field">
				<MarkdownEditor bind:value={content} id="merge-content" original={plan.previousContent} />
			</div>
			<ActorIdentity id="merge-editor" label="검토자" value={form?.editor ?? 'Editor-01'} />
			<label
				><input type="checkbox" name="reviewed" value="yes" required /> 본문과 상충 내용을 확인했고 새
				초안 우선 적용에 동의합니다.</label
			>
			<div class="button-row">
				<button class="primary-button">검토 완료 · 기존 문서에 통합</button>
			</div>
		</form>
		<form method="POST" action={`?/discardMerge&open=${draft.id}`}>
			<input type="hidden" name="id" value={draft.id} /><input
				type="hidden"
				name="version"
				value={draft.version}
			/><button class="secondary-button">통합안 버리기</button>
		</form>
	{/if}
</section>
