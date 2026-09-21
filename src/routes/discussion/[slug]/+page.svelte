<script>
	import FormRecovery from '$lib/components/FormRecovery.svelte';
	import { enhance } from '$app/forms';
	import { enhanceSave } from '$lib/enhance-save.js';
	import { canAccessRoute } from '$lib/auth-policy.js';
	let { data, form } = $props();
	let element = $state();
</script>

<svelte:head><title>{data.document.title} · 토론 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>토론: {data.document.title}</h1>
	<nav class="button-row">
		<a href={`/wiki/${encodeURIComponent(data.document.slug)}`}>문서 읽기</a><a
			href={`/history/${encodeURIComponent(data.document.slug)}`}>역사</a
		>{#if canAccessRoute(data.user?.role, '/proposals/[slug]')}<a
				href={`/proposals/${encodeURIComponent(data.document.slug)}`}>수정 제안</a
			>{/if}
	</nav>
	{#if form?.message}<p class="notice" class:warning={!form.success} role="status">
			{form.message}
		</p>{/if}
	<form method="GET" class="search-filters">
		<label
			>상태<select name="status" value={data.status}
				><option value="">전체</option><option value="open">진행 중</option><option value="resolved"
					>해결됨</option
				></select
			></label
		><button class="secondary-button">적용</button>
	</form>
	<section class="card">
		<h2>토론 목록</h2>
		{#each data.threads as thread}<article class="search-result">
				<h3>
					<a href={`?thread=${thread.id}&status=${data.status}&page=${data.page}`}
						>{thread.thread_title}</a
					>
				</h3>
				<p>
					{thread.status === 'resolved' ? '해결됨' : '진행 중'} · {thread.editor_handle} · 답글 {thread.replies}개
				</p>
			</article>{:else}<p>현재 조건에 맞는 토론이 없습니다.</p>{/each}
		<nav class="pagination" aria-label="토론 목록 페이지">
			{#if data.page > 1}<a href={`?status=${data.status}&page=${data.page - 1}`}>이전</a>{/if}<span
				>{data.page}페이지</span
			>{#if data.page * 20 < data.total}<a href={`?status=${data.status}&page=${data.page + 1}`}
					>다음</a
				>{/if}
		</nav>
	</section>
	{#if data.selected}<section
			class="card discussion-detail"
			id={`thread-${data.selected.id}`}
			tabindex="-1"
		>
			<h2>{data.selected.thread_title}</h2>
			<p>
				{data.selected.editor_handle} · {new Date(data.selected.created_at).toLocaleString('ko-KR')} ·
				{data.selected.status === 'resolved' ? '해결됨' : '진행 중'}
			</p>
			<div class="thread-body">{data.selected.body}</div>
			{#if data.selected.paragraph_anchor}<a
					href={`/wiki/${encodeURIComponent(data.document.slug)}${data.selected.target_revision_id ? `?revision=${data.selected.target_revision_id}` : ''}#${encodeURIComponent(data.selected.paragraph_anchor)}`}
					>토론 대상 문단</a
				>{/if}
			{#if data.selected.resolution_revision_id}<p>
					<a
						href={`/wiki/${encodeURIComponent(data.document.slug)}?revision=${data.selected.resolution_revision_id}`}
						>해결에 연결된 리비전 #{data.selected.resolution_revision_id}</a
					>
				</p>{/if}
			{#if canAccessRoute(data.user?.role, '/proposals/[slug]')}<p>
					<a
						href={`/proposals/${encodeURIComponent(data.document.slug)}?thread=${data.selected.id}`}
						>이 토론에서 수정 제안 만들기</a
					>
				</p>{/if}
			<h3>답글</h3>
			{#each data.replies as reply}<article class="thread">
					<p>{reply.handle} · {new Date(reply.created_at).toLocaleString('ko-KR')}</p>
					<div class="thread-body">{reply.body}</div>
				</article>{:else}<p>아직 답글이 없습니다.</p>{/each}
			<nav class="pagination" aria-label="답글 페이지">
				{#if data.replyPage > 1}<a
						href={`?thread=${data.selected.id}&replies=${data.replyPage - 1}`}>이전 답글</a
					>{/if}{#if data.replyPage * 30 < data.replyTotal}<a
						href={`?thread=${data.selected.id}&replies=${data.replyPage + 1}`}>다음 답글</a
					>{/if}
			</nav>
			{#if data.user && data.selected.status === 'open'}<form
					method="POST"
					action={`?thread=${data.selected.id}`}
				>
					<input type="hidden" name="intent" value="reply" /><input
						type="hidden"
						name="threadId"
						value={data.selected.id}
					/><label
						>답글<textarea name="body" rows="3" maxlength="20000" required
							>{form?.intent === 'reply' && !form.success ? form.body : ''}</textarea
						></label
					><button class="primary-button">답글 등록</button>
				</form>{/if}
			{#if data.canResolve}<form method="POST" action={`?thread=${data.selected.id}`} class="card">
					<input type="hidden" name="intent" value="resolve" /><input
						type="hidden"
						name="threadId"
						value={data.selected.id}
					/><input type="hidden" name="version" value={data.selected.version} /><input
						type="hidden"
						name="status"
						value={data.selected.status === 'open' ? 'resolved' : 'open'}
					/><label
						>실제 수정 리비전 · 선택<select
							name="revisionId"
							value={data.selected.resolution_revision_id || ''}
							><option value="">연결할 수정 없음</option>{#each data.revisions as revision}<option
									value={revision.id}>#{revision.id} · {revision.summary}</option
								>{/each}</select
						></label
					><button class="secondary-button"
						>{data.selected.status === 'open' ? '해결됨으로 표시' : '다시 열기'}</button
					>
				</form>{/if}
		</section>{/if}
	<section class="card">
		<h2>새 토론 시작</h2>
		<form method="POST" bind:this={element} use:enhance={enhanceSave}>
			<FormRecovery
				{element}
				storageKey={`discussion:${data.document.id}`}
				kind="discussion"
				resources={[{ type: 'document', id: data.document.id }]}
			/><input type="hidden" name="intent" value="create" /><input
				type="hidden"
				name="version"
				value={data.document.version}
			/>
			<div class="field">
				<label for="title">주제</label><input
					id="title"
					name="title"
					maxlength="200"
					value={form?.intent === 'create' && !form.success ? form.title : ''}
					required
				/>
			</div>
			<div class="field">
				<label for="body">의견</label><textarea
					id="body"
					name="body"
					rows="5"
					maxlength="20000"
					required>{form?.intent === 'create' && !form.success ? form.body : ''}</textarea
				>
			</div>
			<label
				>대상 문단<select name="anchor"
					><option value="">문서 전체</option>{#each data.toc as heading}<option value={heading.id}
							>{heading.number} {heading.title}</option
						>{/each}</select
				></label
			><label
				>작성자<input
					name="editor"
					value={data.user?.handle || 'Editor-01'}
					readonly={!!data.user}
					required
				/></label
			><button class="primary-button">토론 등록</button>
		</form>
	</section>
</main>

<style>
	.discussion-detail {
		scroll-margin-top: 100px;
	}
</style>
