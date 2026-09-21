<script>
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import WikifyButton from '$lib/components/WikifyButton.svelte';
	import { documentHref } from '$lib/knowledge.js';
	let { data } = $props();
	let title = $state(untrack(() => data.title));
	let checking = $state(false);
	let transportError = $state('');
	const message = $derived(transportError || data.message);
	$effect(() => {
		title = data.title;
	});
	async function checkTitle(event) {
		event.preventDefault();
		if (checking) return;
		const title = new FormData(event.currentTarget).get('title').toString();
		checking = true;
		transportError = '';
		try {
			// Recheck even when a retry submits the same URL after a lookup failure.
			await goto('/new?' + new URLSearchParams({ title }), {
				invalidateAll: true,
				replaceState: page.url.searchParams.get('title') === title
			});
		} catch {
			transportError = '제목 확인 결과를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
		} finally {
			checking = false;
		}
	}
</script>

<svelte:head><title>새 문서 작성 — Wiki Viki</title></svelte:head>

<main class="form-page work-page">
	<header class="document-header">
		<h1>새 문서 작성</h1>
		<p class="muted">
			기록할 지식의 제목을 정해 주세요. 같은 문서나 검토 중인 초안이 있는지 먼저 확인합니다.
		</p>
	</header>
	<form class="wiki-form" method="GET" action="/new" onsubmit={checkTitle} aria-busy={checking}>
		{#if checking}
			<StatusNotice tone="pending">같은 문서나 초안이 있는지 확인하고 있습니다.</StatusNotice>
		{/if}
		{#if message}
			<StatusNotice tone="error" role="alert"><p id="new-title-error">{message}</p></StatusNotice>
		{/if}
		{#if data.existing}
			<StatusNotice title={data.existing.deleted_at ? '휴지통에 있는 문서' : '기존 문서 확인'}>
				<p>같은 제목이나 주소를 사용하는 문서가 있습니다.</p>
				<p><strong>{data.existing.title}</strong></p>
				{#if data.existing.deleted_at}
					<a class="secondary-button" href={'/trash?open=' + data.existing.id}>휴지통에서 확인</a>
				{:else}
					<a class="secondary-button" href={documentHref(data.existing.slug)}>기존 문서 읽기</a>
				{/if}
			</StatusNotice>
		{:else if data.pendingDraft}
			<StatusNotice title="검토 중인 초안">
				<p>같은 제목이나 주소의 미게시 초안이 있습니다. 내용을 확인한 뒤 이어서 검토해 주세요.</p>
				<p><strong>{data.pendingDraft.title}</strong></p>
				<a class="secondary-button" href={'/drafts?open=' + data.pendingDraft.id}>초안 검토하기</a>
			</StatusNotice>
		{/if}
		<div class="field">
			<label for="new-title">새 문서 제목</label>
			<input
				id="new-title"
				name="title"
				bind:value={title}
				required
				maxlength="200"
				readonly={checking}
				aria-invalid={data.invalidTitle ? 'true' : undefined}
				aria-describedby={message ? 'new-title-help new-title-error' : 'new-title-help'}
			/>
			<small id="new-title-help"
				>검색하기 쉬운 구체적인 제목을 사용하세요. 내용을 작성하고 저장하기 전에는 문서가 생성되지
				않습니다.</small
			>
		</div>
		<div class="button-row">
			<button class="primary-button" disabled={checking}
				>{checking ? '제목 확인 중…' : '작성 시작'}</button
			>
			<WikifyButton class="secondary-button">기존 자료로 초안 만들기</WikifyButton>
		</div>
	</form>
</main>
