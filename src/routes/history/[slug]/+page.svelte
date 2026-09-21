<script>
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { enhance } from '$app/forms';
	import MergeHistory from '$lib/components/MergeHistory.svelte';
	let { data, form } = $props();
	let pendingRevision = $state(null);
	let transportError = $state('');
	// Native failed POSTs reload data; never silently replace the reviewed version
	// with a newer document or revision returned by that load.
	let reviewRequired = $derived(
		!!form?.refreshRequired ||
			(!!form?.version &&
				(form.version !== data.version || form.documentId !== String(data.document?.id))) ||
			(!!form?.revisionVersion &&
				!data.revisions.some(
					(revision) =>
						String(revision.id) === form.revision && revision.version === form.revisionVersion
				))
	);
	function rollback({ formData, cancel }) {
		if (pendingRevision || reviewRequired) {
			cancel();
			return;
		}
		pendingRevision = formData.get('revision')?.toString();
		transportError = '';
		return async ({ result, update }) => {
			try {
				if (result.type === 'error') {
					transportError =
						'되돌리기 결과를 확인하지 못했습니다. 연결과 문서의 현재 상태를 확인한 뒤 다시 시도해 주세요.';
					return;
				}
				await update({ reset: false });
			} finally {
				pendingRevision = null;
			}
		};
	}
</script>

<svelte:head
	><title>문서 역사{data.document ? ': ' + data.document.title : ''} — Wiki Viki</title
	></svelte:head
>
<main class="form-page work-page">
	<section class="wiki-form" aria-busy={!!pendingRevision}>
		<header class="document-header">
			<h1>문서 역사{data.document ? ': ' + data.document.title : ''}</h1>
			{#if data.document}
				<div class="document-meta">이 문서에 저장된 모든 버전을 확인할 수 있습니다.</div>
			{/if}
		</header>
		{#if data.document}
			<nav class="document-actions">
				<a class="secondary-button" href={'/wiki/' + data.document.slug}>읽기</a>
				<a class="secondary-button" href={'/edit/' + data.document.slug}>편집</a>
				<a class="secondary-button" href={'/discussion/' + data.document.slug}>토론</a>
			</nav>
		{/if}
		{#if transportError || form?.message}
			<StatusNotice tone="error" role="alert">
				<p>{transportError || form.message}</p>
				{#if !transportError && form?.governance && !form.governance.passed && data.document}
					{#if !form.governance.semantic.unavailable}
						<ul>
							{#each [...form.governance.regex.reasons, ...form.governance.semantic.reasons] as reason}
								<li>{reason}</li>
							{/each}
						</ul>
					{/if}
					<p>
						<a href={'?diff=' + form.revision}>리비전 {form.revision} 차이 확인</a>
						· <a href={'/edit/' + data.document.slug}>현재 문서 편집</a>
					</p>
				{/if}
			</StatusNotice>
		{/if}
		{#if reviewRequired || data.missingDocument || data.databaseError}
			<StatusNotice tone="warning" role="status">
				<p>
					{data.databaseError
						? '문서 이력을 불러오지 못했습니다.'
						: data.missingDocument
							? '문서가 삭제되었거나 주소가 변경되었습니다.'
							: '변경된 내용을 검토하기 전에는 다시 되돌릴 수 없습니다.'}
				</p>
				<a
					href={'/history/' +
						encodeURIComponent(data.slug) +
						(form?.revision ? '?diff=' + encodeURIComponent(form.revision) : '')}
					data-sveltekit-reload>최신 이력 다시 열기</a
				>
			</StatusNotice>
		{/if}
		{#if data.document && !data.semanticAvailable}
			<StatusNotice tone="warning" role="status">
				AI 의미 기반 검사는 실행되지 않습니다. 기본 콘텐츠 보호 검사만 적용되므로 현재 제목·별칭과
				복원할 본문을 직접 검토한 뒤 되돌려 주세요.
			</StatusNotice>
		{/if}
		{#if data.selected}
			<h2>리비전 {data.selected} 변경 사항</h2>
			<div class="diff-box">
				{#each data.changes as part}<span
						class:diff-add={part.added}
						class:diff-remove={part.removed}>{part.value}</span
					>{/each}
			</div>
		{/if}
		{#if data.revisions.length}
			<ul class="history-list">
				{#each data.revisions as revision}
					<li id={'revision-' + revision.id} class:merge-revision={!!revision.merge}>
						<time>{new Date(revision.created_at).toLocaleString('ko-KR')}</time>
						<b>{revision.editor_handle}</b>
						{#if revision.merge}<MergeHistory record={revision.merge} />{:else}<span
								>{revision.summary || '요약 없음'}</span
							>{/if}
						<span>
							<a href={'?diff=' + revision.id}>차이 보기</a> ·
							<form
								method="POST"
								action={'?/rollback' + (data.selected ? '&diff=' + data.selected : '')}
								style="display:inline"
								use:enhance={rollback}
							>
								<input type="hidden" name="revision" value={revision.id} />
								<input type="hidden" name="documentId" value={data.document.id} />
								<input type="hidden" name="version" value={data.version} />
								<input type="hidden" name="revisionVersion" value={revision.version} />
								<button
									class="danger-button"
									disabled={!!pendingRevision || reviewRequired}
									aria-label={'리비전 ' + revision.id + '로 되돌리기'}
								>
									{pendingRevision === String(revision.id)
										? '검사 후 되돌리는 중…'
										: '이 버전으로 되돌리기'}
								</button>
							</form>
						</span>
					</li>
				{/each}
			</ul>
		{:else if data.document}
			<StatusNotice tone="info" role="status">저장된 리비전이 없습니다.</StatusNotice>
		{/if}
	</section>
</main>

<style>
	.history-list li.merge-revision {
		grid-template-columns: minmax(0, 1fr) auto;
	}
	.merge-revision :global(.merge-history),
	.merge-revision > span {
		grid-column: 1 / -1;
	}
</style>
