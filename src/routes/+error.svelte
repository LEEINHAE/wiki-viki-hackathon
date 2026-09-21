<script>
	import { page } from '$app/state';
</script>

<svelte:head><title>문서를 불러올 수 없습니다 — 위키비키</title></svelte:head>
<main class="page-shell">
	<section class="card empty-state">
		<span class="overline">{page.status}</span>
		<h1>잠시, 연결을 확인해 주세요</h1>
		<p>{page.error?.message || '문서를 불러오지 못했습니다.'}</p>
		<div class="button-row" style="justify-content:center">
			<a class="secondary-button" href="/">홈으로</a><a
				class="primary-button"
				href={page.url.pathname + page.url.search}
				data-sveltekit-reload>다시 시도</a
			>
		</div>
	</section>
</main>
