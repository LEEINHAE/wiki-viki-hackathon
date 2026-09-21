<script>
	import { relativeTime, docUrl } from '$lib/wiki-utils.js';
	let { data } = $props();
</script>

<svelte:head><title>최근 변경 — 위키비키</title></svelte:head>
<main class="page-shell">
	<div class="breadcrumbs"><a href="/">위키비키</a><span>/</span><span>최근 변경</span></div>
	<header class="document-header">
		<h1>함께 쌓아가는 지식</h1>
		<p class="muted">누가 무엇을 고쳤는지, 위키의 최근 변경을 살펴보세요.</p>
	</header>
	<section class="card">
		<h2>최근 변경</h2>
		{#if data.problem}<div class="notice warning">
				{data.problem}
			</div>{/if}{#each data.changes as change}<div class="activity-row">
				<a href={docUrl(change)}>{change.title}</a><span>{change.summary || '문서 업데이트'}</span
				><b>{change.editor_handle}</b><time
					title={new Date(change.created_at).toLocaleString('ko-KR')}
					>{relativeTime(change.created_at)}</time
				><a href={`/history/${encodeURIComponent(change.slug)}?diff=${change.id}`}>변경 비교 ↗</a>
			</div>{:else}<div class="empty-state">아직 변경 내역이 없습니다.</div>{/each}
		<div class="button-row" style="margin-top:20px">
			{#if data.page > 1}<a class="secondary-button" href={`?page=${data.page - 1}`}>← 이전</a
				>{/if}{#if data.more}<a class="secondary-button" href={`?page=${data.page + 1}`}>다음 →</a
				>{/if}
		</div>
	</section>
</main>
