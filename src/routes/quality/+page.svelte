<script>
	let { data } = $props();
	const labels = { orphan: '고립 문서', missing: '미작성 링크', source: '출처 누락' };
</script>

<svelte:head><title>링크·출처 점검 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>링크·출처 점검</h1>
	<p>현재 게시 문서의 실제 연결과 출처 등록 여부를 확인합니다.</p>
	<nav class="tag-list" aria-label="점검 종류">
		{#each Object.entries(labels) as [key, label]}<a
				class="tag"
				class:active={data.kind === key}
				href={`?kind=${key}`}>{label}</a
			>{/each}
	</nav>
	{#if data.problem}<p class="notice warning" role="alert">{data.problem}</p>{/if}
	<section class="card">
		<h2>{labels[data.kind]} {data.total}개</h2>
		{#each data.rows as doc}<article class="search-result">
				<a href={`/wiki/${encodeURIComponent(doc.slug)}`}>{doc.title}</a> ·
				<a href={`/edit/${encodeURIComponent(doc.slug)}`}>수정</a>
				{#if data.kind === 'missing'}<div class="tag-list">
						{#each doc.missing as target}<a
								class="tag"
								href={`/edit/${encodeURIComponent(target.slug)}?title=${encodeURIComponent(target.title)}`}
								>{target.title} 작성</a
							>{/each}
					</div>{/if}
			</article>{:else}<p>현재 조건의 문서가 없습니다.</p>{/each}
		<nav class="pagination" aria-label="점검 목록 페이지">
			{#if data.page > 1}<a href={`?kind=${data.kind}&page=${data.page - 1}`}>이전</a>{/if}<span
				>{data.page} 페이지</span
			>{#if data.page * 20 < data.total}<a href={`?kind=${data.kind}&page=${data.page + 1}`}>다음</a
				>{/if}
		</nav>
	</section>
</main>
