<script>
	import EmptyState from './EmptyState.svelte';
	import StatusNotice from './StatusNotice.svelte';
	import { enhance } from '$app/forms';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { formatDate } from '$lib/knowledge.js';
	import { batchReviewLimit, batchReviewReason, reviewToken } from '$lib/draft-review.js';
	let { list, drafts, form } = $props();
	let picked = $state(
		untrack(() => [...new Set(form?.action === 'publishBatch' ? form.selection || [] : [])])
	);
	let expanded = $state({}),
		saving = $state(false),
		mounted = $state(false),
		problem = $state('');
	let active = true;
	let previousList = untrack(() => `${list.filter}:${list.page}`);
	let toolbarTop = $state(78),
		toolbarHeight = $state(100),
		toolbar = $state();
	onMount(() => {
		mounted = true;
	});
	$effect(() => {
		if (!toolbar) return;
		const header = document.querySelector('.topbar');
		if (!header) return;
		const node = toolbar;
		const observer = new ResizeObserver(() => {
			toolbarTop = header.offsetHeight + 12;
			toolbarHeight = node.offsetHeight;
		});
		observer.observe(header);
		observer.observe(node);
		return () => observer.disconnect();
	});
	onDestroy(() => (active = false));
	const eligible = $derived(list.items.filter((draft) => !batchReviewReason(draft)));
	const tokens = $derived(eligible.map(reviewToken));
	const selected = $derived(picked.filter((token) => tokens.includes(token)));
	const batch = $derived(form?.action === 'publishBatch' ? form : null);
	const results = $derived(batch?.results || []);
	const published = $derived(results.filter((item) => item.outcome !== 'failed'));
	const failed = $derived(results.filter((item) => item.outcome === 'failed'));
	$effect(() => {
		// A changed version or a different filter/page needs a new explicit selection.
		const currentList = `${list.filter}:${list.page}`;
		if (currentList !== previousList) {
			previousList = currentList;
			picked = [];
			return;
		}
		const remaining = picked.filter((token) => tokens.includes(token));
		if (remaining.length !== picked.length) picked = remaining;
	});
	beforeNavigate((navigation) => {
		if (!saving) return;
		if (navigation.type === 'leave') navigation.cancel();
		else if (
			navigation.to?.url.pathname === navigation.from?.url.pathname &&
			navigation.to?.url.search === navigation.from?.url.search
		)
			return;
		else if (
			!window.confirm(
				'초안을 게시 중입니다. 이동해도 처리는 계속될 수 있습니다. 결과를 확인하기 전에 이동할까요?'
			)
		)
			navigation.cancel();
	});
	const listUrl = (filter, page = 1) => `/drafts?status=${filter}&page=${page}`;
	async function refresh() {
		if (saving) return;
		problem = '';
		try {
			await invalidateAll();
		} catch {
			problem = '목록을 새로 불러오지 못했습니다. 선택을 유지했으니 다시 시도해 주세요.';
		}
	}
	function submit({ cancel }) {
		if (saving || !selected.length) {
			cancel();
			return;
		}
		saving = true;
		problem = '';
		return async ({ result, update }) => {
			try {
				if (!active) return;
				if (!['success', 'failure'].includes(result.type)) {
					problem =
						'게시 결과를 확인하지 못했습니다. 목록을 새로 확인해 주세요. 이미 게시된 초안은 다시 선택해도 중복 게시하지 않습니다.';
					return;
				}
				await update({ reset: false });
				if (!active) return;
				const completed = new Set(
					(result.data?.results || [])
						.filter((item) => item.outcome !== 'failed')
						.map((item) => String(item.id))
				);
				picked = picked.filter((token) => !completed.has(token.split(':')[0]));
			} catch {
				if (active)
					problem = '화면을 갱신하지 못했습니다. 게시 결과와 목록을 확인한 뒤 다시 시도해 주세요.';
			} finally {
				if (active) saving = false;
			}
		};
	}
</script>

<nav class="review-filters chips" aria-label="초안 상태 필터">
	{#each [{ id: 'all', label: '전체' }, { id: 'review', label: '검토 대기' }, { id: 'blocked', label: '확인 필요' }] as item}
		<a
			class="chip"
			class:selected={list.filter === item.id}
			aria-current={list.filter === item.id ? 'page' : undefined}
			href={listUrl(item.id)}
			>{item.label}
			{drafts.filter((draft) => item.id === 'all' || draft.status === item.id).length}</a
		>
	{/each}
</nav>

{#if batch?.message || problem}<StatusNotice tone="error" role="alert">
		<p>{problem || batch.message}</p>
		<button type="button" class="secondary-button" onclick={refresh} disabled={saving}
			>목록 새로 확인</button
		>
	</StatusNotice>{/if}
{#if results.length}<section class="batch-results" aria-label="선택 게시 결과">
		<StatusNotice tone={failed.length ? 'warning' : 'success'}>
			<h2>게시 결과 · 완료 {published.length}개 / 확인 필요 {failed.length}개</h2>
			<ul>
				{#each results as item}<li>
						{#if item.outcome === 'failed'}
							<a href={`/drafts?open=${item.id}`}
								>{drafts.find((draft) => String(draft.id) === String(item.id))?.title ||
									`초안 #${item.id}`}</a
							>
							<span>{item.message}</span>
						{:else}
							<a href={`/wiki/${encodeURIComponent(item.slug)}`}>{item.title} ↗</a>
							<span
								>{item.outcome === 'alreadyPublished'
									? '이미 게시됨 · 중복 생성하지 않았습니다.'
									: '게시 완료'}</span
							>
						{/if}
					</li>{/each}
			</ul>
			{#if published.some((item) => item.semanticSkipped)}<p>
					AI 의미 검사가 생략된 문서가 있습니다. 직접 검토한 내용으로 게시했습니다.
				</p>{/if}
			{#if failed.length}<p>
					실패한 초안은 목록에 남겨 두었습니다. 내용을 수정하거나 현재 상태를 확인한 뒤 다시 시도해
					주세요.
				</p>{/if}
		</StatusNotice>
	</section>{/if}

{#if list.items.length}
	<form
		method="POST"
		action={`?/publishBatch&status=${list.filter}&page=${list.page}`}
		use:enhance={submit}
		aria-busy={saving}
		style:--review-scroll-margin={`${toolbarTop + toolbarHeight + 16}px`}
	>
		<div
			class="review-toolbar"
			class:interactive={mounted}
			style:top={`${toolbarTop}px`}
			bind:this={toolbar}
		>
			<div>
				<strong>{mounted ? `${selected.length}개 선택` : '검토 후 선택 게시'}</strong>
				<p class="small muted">
					본문을 검토한 초안을 선택하세요. 한 번에 최대 {batchReviewLimit}개를 새 문서로 게시합니다.
				</p>
			</div>
			<div class="review-actions">
				{#if mounted}<button
						type="button"
						class="secondary-button"
						disabled={saving || !tokens.length}
						onclick={() => (picked = selected.length ? [] : tokens.slice(0, batchReviewLimit))}
					>
						{selected.length
							? '선택 해제'
							: tokens.length > batchReviewLimit
								? `앞의 ${batchReviewLimit}개 선택`
								: '전체 선택'}
					</button>{/if}
				<button
					class="primary-button"
					name="confirmPublish"
					value="yes"
					disabled={saving || (mounted && !selected.length)}
				>
					{saving ? '선택 초안 게시 중…' : '선택한 초안 게시'}
				</button>
			</div>
		</div>
		{#if saving}<StatusNotice tone="pending" role="status">
				선택한 초안을 검사하고 게시하고 있습니다. 완료되면 항목별 결과를 보여 드립니다.
			</StatusNotice>{/if}
		<p class="review-hint small muted">
			내용과 별칭은 저장된 초안 기준입니다. 수정·통합은 각 초안에서 진행하세요. 필터·페이지를 바꾸면
			선택이 해제됩니다.
		</p>
		<ol class="review-list">
			{#each list.items as draft (draft.id)}
				{@const reason = batchReviewReason(draft)}
				{@const token = reviewToken(draft)}
				{@const long = draft.content.length > 600 || draft.content.split('\n').length > 12}
				<li class="review-row" class:chosen={selected.includes(token)}>
					<div class="review-heading">
						<input
							type="checkbox"
							name="draft"
							value={token}
							bind:group={picked}
							aria-label={`${draft.title} 검토 완료로 선택`}
							aria-describedby={`review-state-${draft.id}`}
							disabled={saving ||
								!!reason ||
								(mounted && selected.length >= batchReviewLimit && !selected.includes(token))}
						/>
						<div class="review-title">
							<h2>{draft.title}</h2>
							<p class="small muted">
								{draft.source_name || '직접 작성'} · {formatDate(draft.created_at)} · {draft.editor_handle}
							</p>
						</div>
						<a class="secondary-button" href={`/drafts?open=${draft.id}`}
							>수정·통합 <span class="sr-only">{draft.title}</span> →</a
						>
					</div>
					<div class="review-state" id={`review-state-${draft.id}`}>
						<span class="tag">{reason ? '개별 확인 필요' : '검토 대기'}</span>
						{#if reason}<span>{reason}</span>{/if}
						{#if draft.governance?.semantic?.skipped}<span
								>AI 의미 검사 생략 · 직접 확인해 주세요.</span
							>{/if}
					</div>
					{#if reason}<ul class="review-reasons">
							{#each [...(draft.governance?.regex?.reasons || []), ...(draft.governance?.semantic?.reasons || [])] as text}<li
								>
									{text}
								</li>{/each}
						</ul>{/if}
					{#if Array.isArray(draft.aliases) && draft.aliases.length}<p class="small muted">
							별칭: {draft.aliases.join(', ')}
						</p>{/if}
					<div
						class="review-body"
						class:collapsed={long && mounted && !expanded[draft.id]}
						id={`review-body-${draft.id}`}
					>
						<article class="wiki-preview wiki-content" aria-label={`${draft.title} 저장된 본문`}>
							{@html draft.previewHtml}
						</article>
					</div>
					{#if long && mounted}<button
							type="button"
							class="text-link expand-review"
							aria-expanded={!!expanded[draft.id]}
							aria-controls={`review-body-${draft.id}`}
							onclick={() => (expanded[draft.id] = !expanded[draft.id])}
						>
							{expanded[draft.id] ? '본문 접기' : '본문 전체 보기'}
							<span class="sr-only">{draft.title}</span>
						</button>{/if}
				</li>
			{/each}
		</ol>
	</form>
	{#if list.pages > 1}<nav class="review-pagination" aria-label="초안 목록 페이지">
			{#if list.page > 1}<a class="secondary-button" href={listUrl(list.filter, list.page - 1)}
					>← 이전</a
				>{/if}
			<span>{list.page} / {list.pages} 페이지 · {list.total}개</span>
			{#if list.page < list.pages}<a
					class="secondary-button"
					href={listUrl(list.filter, list.page + 1)}>다음 →</a
				>{/if}
		</nav>{/if}
{:else}
	<EmptyState title={drafts.length ? '이 상태의 초안은 없어요.' : '지금은 검토할 초안이 없어요.'}>
		<p>
			{drafts.length
				? '다른 상태의 초안을 확인해 보세요.'
				: '가지고 있는 문서로 다음 지식을 시작해 보세요.'}
		</p>
		{#snippet actions()}
			<a class="primary-button" href={drafts.length ? '/drafts' : '/wikify'}
				>{drafts.length ? '전체 초안 보기' : 'AI 위키파이어 열기 ↗'}</a
			>
		{/snippet}
	</EmptyState>
{/if}
<noscript
	><p class="small muted">
		초안의 체크박스를 선택한 뒤 선택 게시 버튼을 누르세요. 한 번에 최대 {batchReviewLimit}개를
		게시할 수 있습니다.
	</p>
</noscript>

<style>
	.review-filters {
		margin: 1.5rem 0;
	}
	.review-toolbar {
		position: static;
		top: 5rem;
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: var(--inset-padding);
		border: 1px solid var(--line);
		border-radius: var(--inset-radius);
		background: var(--paper);
		box-shadow: var(--shadow);
	}
	.review-toolbar.interactive {
		position: sticky;
	}
	.review-toolbar p {
		margin: 0.3rem 0 0;
	}
	.review-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
		flex-wrap: wrap;
	}
	.review-hint {
		margin: 1rem 0;
	}
	.review-list {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 1rem;
	}
	.review-row {
		min-width: 0;
		padding: var(--panel-padding);
		border: 1px solid var(--line);
		border-radius: var(--inset-radius);
	}
	.review-row.chosen {
		border-color: var(--accent);
		box-shadow: inset 3px 0 var(--accent);
	}
	.review-heading {
		display: flex;
		align-items: start;
		gap: 0.9rem;
	}
	.review-heading input {
		width: 1.25rem;
		height: 1.25rem;
		margin: 0.35rem 0 0;
		flex-shrink: 0;
		accent-color: var(--accent);
	}
	.review-title {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.review-title h2 {
		font-size: 1.45rem;
		margin: 0;
	}
	.review-title p {
		margin: 0.4rem 0;
	}
	.review-heading a {
		white-space: nowrap;
	}
	.review-state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: var(--secondary);
		margin: 0.8rem 0;
	}
	.review-reasons {
		font-size: 0.85rem;
		color: var(--secondary);
	}
	.review-reasons:empty {
		display: none;
	}
	.review-body {
		position: relative;
		overflow-wrap: anywhere;
	}
	.review-body.collapsed {
		max-height: 20rem;
		overflow: hidden;
	}
	.review-body.collapsed::after {
		content: '';
		position: absolute;
		inset: auto 0 0;
		height: 3rem;
		background: linear-gradient(transparent, var(--paper));
		pointer-events: none;
	}
	.review-actions button,
	.review-row input,
	.review-row a,
	.review-row button,
	.review-body :global([id]) {
		scroll-margin-top: var(--review-scroll-margin);
	}
	.review-body :global(.wiki-content) {
		font-size: 0.95rem;
	}
	.review-body :global(h1),
	.review-body :global(h2) {
		font-size: 1.25rem;
	}
	.expand-review {
		background: none;
		border: 0;
		padding: 0.8rem 0 0;
		cursor: pointer;
	}
	.batch-results h2 {
		font-size: 1.15rem;
	}
	.batch-results ul {
		padding-left: 1.2rem;
	}
	.batch-results li {
		margin: 0.7rem 0;
		overflow-wrap: anywhere;
	}
	.batch-results li span {
		display: block;
		margin-top: 0.25rem;
		font-size: 0.85rem;
	}
	.review-pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		margin-top: 1.5rem;
	}
	@media (max-width: 800px) {
		.review-toolbar {
			flex-direction: column;
			align-items: stretch;
			gap: 0.6rem;
		}
		.review-actions > * {
			flex: 1;
			justify-content: center;
		}
		.review-toolbar p {
			font-size: 0.75rem;
		}
		.review-row {
			padding: var(--inset-padding);
		}
		.review-heading {
			flex-wrap: wrap;
			gap: 0.6rem;
		}
		.review-title {
			flex-basis: calc(100% - 2rem);
		}
		.review-heading a {
			margin-left: 1.85rem;
		}
		.review-title h2 {
			font-size: 1.25rem;
		}
		.review-pagination {
			font-size: 0.85rem;
		}
	}
	@media (max-height: 650px) {
		.review-toolbar.interactive {
			position: static;
		}
	}
</style>
