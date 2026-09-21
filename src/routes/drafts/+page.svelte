<script>
	import { enhance } from '$app/forms';
	import { formatDate } from '$lib/knowledge.js';
	import { page } from '$app/state';
	import DraftMergePanel from '$lib/components/DraftMergePanel.svelte';
	let { data, form } = $props();
	let filter = $state('all');
	let saving = $state(false);
	let busyAction = $state('');
	let dirty = $state(false);
	let preview = $state(false);
	let actionError = $state('');
	const drafts = $derived(
		data.drafts.filter((draft) => filter === 'all' || draft.status === filter)
	);
	$effect(() => {
		page.url.search;
		dirty = false;
		preview = false;
		actionError = '';
	});
	function submitAction({ formElement }) {
		saving = true;
		busyAction = new URL(formElement.action).search.slice(2);
		actionError = '';
		return async ({ result, update }) => {
			if (result.type === 'error') {
				saving = false;
				busyAction = '';
				actionError = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
				return;
			}
			await update({ reset: false });
			saving = false;
			busyAction = '';
			if (result.type !== 'failure') dirty = false;
		};
	}
</script>

<svelte:head><title>초안 검토 — 위키비키</title></svelte:head>
<main class="form-page">
	<section class="wiki-form">
		<header class="document-header">
			<span class="eyebrow">함께 완성하는 지식</span>
			<h1>{data.selected ? data.selected.title : '검토를 기다리는 초안'}</h1>
			<p class="muted small">
				{data.selected
					? `원본: ${data.selected.source_name || '직접 작성'} · ${formatDate(data.selected.created_at)}`
					: 'AI가 시작한 문서를, 사람의 경험으로 완성합니다.'}
			</p>
		</header>
		{#if data.databaseError}<div class="notice warning">
				초안을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
			</div>{/if}{#if form?.message || actionError}<div class="notice warning" role="alert">
				{actionError || form.message}
			</div>{/if}
		{#if data.selected}
			<div class="notice" class:warning={data.selected.status === 'blocked'}>
				<strong
					>{data.selected.status === 'blocked'
						? '게시 전 확인이 필요합니다.'
						: '검토 후 게시할 수 있는 초안입니다.'}</strong
				><span>
					내용을 확인하고 필요한 부분을 수정해 주세요.</span
				>{#if data.selected.governance?.semantic?.skipped}<p class="small">
						AI 의미 기반 검사는 실행되지 않았습니다. 내용을 직접 확인해 주세요.
					</p>{/if}{#each [...(data.selected.governance?.regex?.reasons || []), ...(data.selected.governance?.semantic?.reasons || [])] as reason}<p
						class="small"
					>
						· {reason}
					</p>{/each}
			</div>
			{#if data.siblings?.length}<div class="sibling-drafts">
					<p class="small muted">같은 원본에서 만든 초안</p>
					<div class="chips">
						{#each data.siblings as sibling}<a class="chip" href={`?open=${sibling.id}`}
								>{sibling.title} ↗</a
							>{/each}
					</div>
				</div>{/if}
			{#key data.selected.id}<DraftMergePanel
					{data}
					{saving}
					{dirty}
					{busyAction}
					{submitAction}
				/>{/key}
			<div class="draft-tabs">
				<button class="secondary-button" onclick={() => (preview = false)} aria-pressed={!preview}
					>내용 수정</button
				><button class="secondary-button" onclick={() => (preview = true)} aria-pressed={preview}
					>저장된 초안 미리보기</button
				>
			</div>
			{#if preview}{#if dirty}<div class="notice warning">
						저장되지 않은 수정 사항은 미리보기에 반영되지 않습니다.
					</div>{/if}
				<article class="wiki-content">{@html data.previewHtml}</article>{/if}
			<form
				method="POST"
				action="?/update"
				use:enhance={submitAction}
				hidden={preview}
				oninput={() => (dirty = true)}
			>
				<input type="hidden" name="id" value={data.selected.id} />
				<input type="hidden" name="version" value={data.selected.version} />
				<div class="field">
					<label for="title">문서 제목</label><input
						id="title"
						name="title"
						value={data.selected.title}
						disabled={saving}
						required
					/>
				</div>
				<div class="field">
					<label for="content">위키 본문</label><textarea
						id="content"
						name="content"
						required
						disabled={saving}>{data.selected.content}</textarea
					><small>[[문서 이름]]으로 다른 지식을 연결할 수 있습니다.</small>
				</div>
				<div class="field">
					<label for="editor">검토자 이름</label><input
						id="editor"
						name="editor"
						value={data.selected.editor_handle}
						disabled={saving}
						pattern={'(?:Editor-[0-9]{2,}|Operator-[A-Z][A-Z0-9\\-]*)'}
						required
					/>
				</div>
				<div class="button-row">
					<button class="secondary-button" disabled={saving}
						>{busyAction === 'update' ? '저장 중…' : '검토 내용 저장'}</button
					>
				</div>
			</form>
			<div class="draft-publish-bar">
				<a class="text-link" href="/drafts">← 목록으로</a>
				<div class="button-row">
					<form
						method="POST"
						action="?/delete"
						use:enhance={submitAction}
						onsubmit={(event) => {
							if (!confirm('이 초안을 삭제할까요? 삭제한 초안은 복구할 수 없습니다.'))
								event.preventDefault();
						}}
					>
						<input type="hidden" name="id" value={data.selected.id} /><button
							class="danger-button"
							disabled={saving}>초안 삭제</button
						>
						<input type="hidden" name="version" value={data.selected.version} />
					</form>
					<form method="POST" action="?/publish" use:enhance={submitAction}>
						<input type="hidden" name="version" value={data.selected.version} />
						<input type="hidden" name="id" value={data.selected.id} /><button
							class="primary-button"
							disabled={saving || dirty || data.duplicate || data.selected.status === 'blocked'}
							>{busyAction === 'publish' ? '검사 후 게시 중…' : '검토 완료 · 새 문서 게시'}</button
						>
					</form>
				</div>
			</div>
			{#if data.duplicate}<p class="small muted">
					같은 이름의 문서가 있습니다. 위의 AI 통합을 사용하거나 제목을 변경해 새 문서로 게시해
					주세요.
				</p>{/if}
			{#if dirty}<p class="small muted">
					수정 사항을 먼저 저장하면 문서를 게시할 수 있습니다.
				</p>{/if}
		{:else}
			<div class="draft-tabs" aria-label="초안 상태 필터">
				{#each [{ id: 'all', label: '전체' }, { id: 'review', label: '검토 대기' }, { id: 'blocked', label: '확인 필요' }] as item}<button
						class="chip"
						class:selected={filter === item.id}
						onclick={() => (filter = item.id)}
						>{item.label}
						{data.drafts.filter((draft) => item.id === 'all' || draft.status === item.id)
							.length}</button
					>{/each}
			</div>
			{#each drafts as draft}<div class="draft-row">
					<div>
						<span class="tag">{draft.status === 'blocked' ? '확인 필요' : 'AI 초안'}</span>
						<h3><a href={`?open=${draft.id}`}>{draft.title}</a></h3>
						<small
							>{draft.source_name || '직접 작성'} · {formatDate(draft.created_at)} · {draft.editor_handle}</small
						>
					</div>
					<a class="secondary-button" href={`?open=${draft.id}`}>검토하기 →</a>
				</div>{:else}<div class="empty-state">
					<h2>지금은 검토할 초안이 없어요.</h2>
					<p>가지고 있는 문서로 다음 지식을 시작해 보세요.</p>
					<a class="primary-button" href="/wikify">AI 위키파이어 열기 ↗</a>
				</div>{/each}
		{/if}
	</section>
</main>
