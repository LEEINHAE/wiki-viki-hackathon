<script>
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let restoring = $state(false),
		transportError = $state('');
	let reviewRequired = $derived(
		!!form?.refreshRequired ||
			(!!form?.version &&
				(form.version !== data.selected?.version ||
					form.documentId !== String(data.selected?.document.id)))
	);
	function restore({ cancel }) {
		if (restoring || reviewRequired) {
			cancel();
			return;
		}
		restoring = true;
		transportError = '';
		return async ({ result, update }) => {
			try {
				if (result.type === 'error')
					transportError =
						'복구 결과를 확인하지 못했습니다. 연결과 문서 상태를 확인한 뒤 다시 시도해 주세요.';
				else await update({ reset: false });
			} finally {
				restoring = false;
			}
		};
	}
</script>

<svelte:head><title>휴지통 — Wiki Viki</title></svelte:head>
<main class="form-page work-page">
	<section class="wiki-form" aria-busy={restoring}>
		<header class="document-header">
			<h1>휴지통</h1>
			<p>문서와 리비전·별칭·토론을 보관합니다. 복구하면 원래 주소에서 다시 읽을 수 있습니다.</p>
			<p class="muted">
				보관된 제목과 주소·별칭은 다른 문서에서 사용할 수 없습니다. 최근 이동한 순서로 한 페이지에
				50개씩 표시합니다.
			</p>
		</header>
		{#if data.databaseError || transportError || form?.message}
			<StatusNotice tone="error" role="alert">
				{data.databaseError || transportError || form.message}
			</StatusNotice>
		{/if}
		{#if reviewRequired || data.databaseError || data.missingSelection}
			<StatusNotice tone="warning" role="status">
				<p>
					{data.missingSelection
						? '선택한 문서가 휴지통에 없습니다. 이미 복구되었거나 상태가 바뀌었을 수 있습니다.'
						: '휴지통의 최신 내용을 확인해 주세요.'}
				</p>
				<a
					href={'/trash' + (form?.documentId ? '?open=' + encodeURIComponent(form.documentId) : '')}
					data-sveltekit-reload>최신 휴지통 다시 열기</a
				>
			</StatusNotice>
		{/if}
		{#if data.documents.length}
			<nav aria-label="휴지통 문서">
				<ul class="trash-list">
					{#each data.documents as doc}<li>
							<a
								href={'/trash?page=' + data.page + '&open=' + doc.id}
								aria-current={String(data.selected?.document.id) === String(doc.id)
									? 'page'
									: undefined}>{doc.title}</a
							>
							<small
								><time datetime={new Date(doc.deleted_at).toISOString()}
									>{new Date(doc.deleted_at).toLocaleString('ko-KR')}</time
								>
								· {doc.deleted_by}</small
							>
						</li>{/each}
				</ul>
			</nav>
		{:else if !data.databaseError}<StatusNotice tone="info" role="status"
				>휴지통이 비어 있습니다.</StatusNotice
			>{/if}
		{#if data.pages > 1}<nav class="button-row" aria-label="휴지통 페이지">
				{#if data.page > 1}<a class="secondary-button" href={'/trash?page=' + (data.page - 1)}
						>이전 페이지</a
					>{/if}
				<span>{data.page} / {data.pages}</span>
				{#if data.page < data.pages}<a
						class="secondary-button"
						href={'/trash?page=' + (data.page + 1)}>다음 페이지</a
					>{/if}
			</nav>{/if}
		{#if data.selected}
			<h2>{data.selected.document.title}</h2>
			<p>원래 주소: <span class="original-address">/wiki/{data.selected.document.slug}</span></p>
			<p>보관한 별칭: {data.selected.aliases.map((a) => a.alias_title).join(', ') || '없음'}</p>
			<div class="field">
				<label for="trash-content">보관된 본문</label><textarea
					id="trash-content"
					class="trash-content"
					readonly>{data.selected.document.content}</textarea
				>
			</div>
			<form
				method="POST"
				action={'?/restore&page=' + data.page + '&open=' + data.selected.document.id}
				use:enhance={restore}
			>
				<input
					type="hidden"
					name="documentId"
					value={form?.documentId ?? data.selected.document.id}
				/>
				<input type="hidden" name="version" value={form?.version ?? data.selected.version} />
				<button
					class="primary-button"
					disabled={restoring || reviewRequired || !!data.databaseError}
					>{restoring ? '복구 중…' : '문서 복구'}</button
				>
			</form>
		{/if}
		<p><a href="/">홈으로</a></p>
	</section>
</main>

<style>
	.trash-list {
		list-style: none;
		padding: 0;
		margin: 1.5rem 0;
	}
	.trash-list li {
		border-bottom: 1px solid var(--line);
		padding: 0.75rem 0;
		overflow-wrap: anywhere;
	}
	.trash-list small {
		display: block;
		color: var(--muted);
		margin-top: 0.25rem;
	}
	.trash-list a[aria-current='page'] {
		font-weight: 700;
	}
	.trash-content {
		min-height: 12rem;
		max-height: 24rem;
		white-space: pre-wrap;
	}
	.original-address {
		overflow-wrap: anywhere;
	}
</style>
