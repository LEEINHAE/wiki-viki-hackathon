<script>
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let submitting = $state(false);
	let transportError = $state('');
	const slug = $derived(encodeURIComponent(data.document?.slug || data.slug));
	const fieldsToFix = $derived([
		...new Map((form?.governance?.fields ?? []).map(({ field, label }) => [field, label]))
	]);
	function submit({ cancel }) {
		if (submitting) {
			cancel();
			return;
		}
		submitting = true;
		transportError = '';
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					transportError =
						'등록 결과를 확인하지 못했습니다. 작성한 내용을 유지했습니다. 연결과 토론 목록을 확인한 뒤 다시 시도해 주세요.';
					return;
				}
				await update({ reset: result.type === 'success' });
			} finally {
				submitting = false;
			}
		};
	}
</script>

<svelte:head
	><title>{data.document ? '토론: ' + data.document.title : '토론'} — Wiki Viki</title></svelte:head
>
<main class="form-page work-page">
	<section class="wiki-form">
		<header class="document-header">
			<h1>{data.document ? '토론: ' + data.document.title : '토론'}</h1>
			<div class="document-meta">의견이 엇갈리는 내용은 편집 전에 토론해 주세요.</div>
		</header>
		<nav class="document-actions">
			<a class="secondary-button" href={'/wiki/' + slug}>읽기</a>
			<a class="secondary-button" href={'/edit/' + slug}>편집</a>
			<a class="secondary-button" href={'/history/' + slug}>역사</a>
		</nav>
		{#if data.databaseError}<StatusNotice tone="error" role="alert"
				>{data.databaseError}</StatusNotice
			>{/if}
		{#if transportError || form?.message}
			<StatusNotice tone="error" role="alert">
				<p>{transportError || form.message}</p>
				{#if !transportError && form?.governance && !form.governance.passed && !form.governance.semantic.unavailable}
					<ul>
						{#each [...form.governance.regex.reasons, ...form.governance.semantic.reasons] as reason}<li
							>
								{reason}
							</li>{/each}
					</ul>
					{#each fieldsToFix as [field, label]}<p>
							<a href={'#' + field}>{label} 수정하기</a>
						</p>{/each}
				{/if}
			</StatusNotice>
		{/if}
		{#if form?.success && !transportError}<StatusNotice tone="success" role="status">
				토론을 등록했습니다.
			</StatusNotice>{/if}
		{#if data.threads}
			{#each data.threads as thread}
				<article class="thread">
					<div class="thread-head">
						<h2>{thread.thread_title}</h2>
						<span
							>{thread.editor_handle} · {new Date(thread.created_at).toLocaleString('ko-KR')}</span
						>
					</div>
					<div class="thread-body">{thread.body}</div>
				</article>
			{:else}
				<p class="muted">아직 토론이 없습니다. 아래에서 첫 토론을 시작해 보세요.</p>
			{/each}
		{/if}
		<h2>새 토론 시작</h2>
		{#if !data.semanticAvailable || form?.semanticSkipped}
			<StatusNotice tone="warning" role="status">
				AI 의미 기반 검사는 실행되지 않습니다. 기본 콘텐츠 보호 검사만 적용되므로 주제·의견을 직접
				검토한 뒤 등록해 주세요.
			</StatusNotice>
		{/if}
		<form method="POST" use:enhance={submit} aria-busy={submitting}>
			<div class="field">
				<label for="title">주제</label><input
					id="title"
					name="title"
					value={form?.title ?? ''}
					required
					disabled={submitting}
				/>
			</div>
			<div class="field">
				<label for="body">의견</label><textarea
					id="body"
					name="body"
					style="min-height:130px"
					required
					disabled={submitting}>{form?.body ?? ''}</textarea
				>
			</div>
			<div class="field">
				<label for="editor">익명 사용자 이름</label><input
					id="editor"
					name="editor"
					value={form?.editor ?? 'Editor-01'}
					required
					disabled={submitting}
				/>
			</div>
			<div class="button-row">
				<button class="primary-button" disabled={submitting || !!data.databaseError}
					>{submitting ? '검사 후 등록 중…' : '토론 등록'}</button
				>
			</div>
		</form>
	</section>
</main>
