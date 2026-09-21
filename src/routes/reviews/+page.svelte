<script>
	let { data } = $props();
</script>

<svelte:head><title>정기 검토 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>다시 검토할 문서</h1>
	<p>검토 기한이 지났거나 본문이 변경되어 검토가 필요한 문서입니다. 서울 날짜 기준입니다.</p>
	<section class="card">
		{#each data.rows as row}<article class="search-result">
				<h2><a href={`/wiki/${encodeURIComponent(row.slug)}`}>{row.title}</a></h2>
				<p>
					담당자 {row.owner || '미지정'} · 검토 기한 {row.wv_next_review_on?.slice(0, 10) ||
						'미지정'}
				</p>
				<a href={`/manage/${encodeURIComponent(row.slug)}`}>검토 기록하기</a>
			</article>{:else}<p>현재 조건에 맞는 문서가 없습니다.</p>{/each}
		<nav class="pagination" aria-label="검토 목록 페이지">
			{#if data.page > 1}<a href={`?page=${data.page - 1}`}>이전</a>{/if}<span
				>{data.page}페이지</span
			>{#if data.page * 20 < data.total}<a href={`?page=${data.page + 1}`}>다음</a>{/if}
		</nav>
	</section>
</main>
