<script>
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import FormRecovery from '$lib/components/FormRecovery.svelte';
	import { enhance } from '$app/forms';
	import { enhanceSave } from '$lib/enhance-save.js';
	let { data, form } = $props();
	let content = $state(''),
		finalContent = $state(''),
		element = $state();
	$effect(() => {
		content = form?.creating ? form.content : data.document.content;
		finalContent = form?.content && !form.creating ? form.content : data.selected?.content || '';
	});
	const labels = { open: '검토 대기', accepted: '승인·게시', rejected: '반려' };
</script>

<svelte:head><title>{data.document.title} 수정 제안 — 위키비키</title></svelte:head>
<main class="page-shell">
	<a href={`/wiki/${encodeURIComponent(data.document.slug)}`}>← 문서 읽기</a>
	<h1>{data.document.title} · 수정 제안</h1>
	<p>제안은 검토자가 승인하기 전까지 게시 본문에 반영되지 않습니다.</p>
	{#if form?.message}<p class="notice warning" role="alert">{form.message}</p>{/if}
	{#if data.selected}<section class="card">
			<h2>제안 #{data.selected.id} · {labels[data.selected.status]}</h2>
			<p>{data.selected.proposer} · {data.selected.summary}</p>
			{#if data.selected.discussion_id}<a
					href={`/discussion/${encodeURIComponent(data.document.slug)}?thread=${data.selected.discussion_id}`}
					>관련 토론</a
				>{/if}
			<details open>
				<summary>제안 당시 본문과 비교</summary>
				<pre class="diff-box">{#each data.changes as part}<span
							class:diff-add={part.added}
							class:diff-remove={part.removed}>{part.value}</span
						>{/each}</pre>
			</details>
			{#if data.selected.status === 'open' && data.canReview}
				{#if data.selected.base_version !== data.document.version}<p class="notice warning">
						제안 이후 문서가 바뀌어 승인할 수 없습니다. 최신 본문을 기준으로 새 제안을 작성해
						주세요.
					</p>{/if}
				<form method="POST" action={`?/decide&open=${data.selected.id}`} use:enhance={enhanceSave}>
					<input type="hidden" name="id" value={data.selected.id} /><input
						type="hidden"
						name="version"
						value={data.selected.version}
					/><MarkdownEditor bind:value={finalContent} original={data.selected.base_content} /><label
						>결정 사유<textarea name="note" rows="2" maxlength="2000">{form?.note || ''}</textarea
						></label
					><label
						><input type="checkbox" name="reviewed" value="yes" /> 최종 본문과 출처를 확인했습니다.</label
					>{#if data.selected.discussion_id}<label
							><input type="checkbox" name="resolveThread" value="yes" /> 관련 토론을 이 리비전으로 해결
							표시합니다.</label
						>{/if}
					<div class="button-row">
						<button
							class="primary-button"
							name="decision"
							value="accepted"
							disabled={data.selected.base_version !== data.document.version}>승인하고 게시</button
						><button class="secondary-button" name="decision" value="rejected">반려</button>
					</div>
				</form>
			{:else}<div class="wiki-content">{@html data.html}</div>
				{#if data.selected.decision_revision_id}<a
						href={`/wiki/${encodeURIComponent(data.document.slug)}?revision=${data.selected.decision_revision_id}`}
						>실제 게시 리비전 #{data.selected.decision_revision_id}</a
					>{/if}
				<p>{data.selected.decision_note}</p>{/if}
		</section>{/if}
	<section class="card">
		<h2>제안 목록</h2>
		{#each data.rows as row}<article class="search-result">
				<a href={`?open=${row.id}`}>#{row.id} · {row.summary}</a>
				<p>{row.proposer} · {labels[row.status]}</p>
			</article>{:else}<p>아직 수정 제안이 없습니다.</p>{/each}
		<nav class="pagination" aria-label="제안 목록 페이지">
			{#if data.page > 1}<a href={`?page=${data.page - 1}`}>이전</a>{/if}<span
				>{data.page}페이지</span
			>{#if data.page * 20 < data.total}<a href={`?page=${data.page + 1}`}>다음</a>{/if}
		</nav>
	</section>
	<section class="card">
		<h2>새 수정 제안</h2>
		{#if data.thread}<p>연결할 토론: {data.thread.thread_title}</p>{/if}
		<form method="POST" action="?/create" bind:this={element} use:enhance={enhanceSave}>
			<FormRecovery
				{element}
				storageKey={`proposal:${data.document.id}`}
				kind="proposal"
				resources={[{ type: 'document', id: data.document.id }]}
			/><input
				type="hidden"
				name="version"
				value={form?.creating ? form.version : data.document.version}
			/><input type="hidden" name="discussionId" value={data.thread?.id || ''} /><MarkdownEditor
				bind:value={content}
				original={data.document.content}
				id="proposal-content"
			/><label
				>변경 이유<textarea name="summary" rows="3" maxlength="2000" required
					>{form?.creating ? form.summary : ''}</textarea
				></label
			><button class="primary-button">검토 요청</button>
		</form>
	</section>
</main>
