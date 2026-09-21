<script>
	import { page } from '$app/state';
	const title = $derived(
		page.status === 403
			? '이 화면은 사용할 수 없습니다'
			: page.status === 404
				? '페이지를 찾을 수 없습니다'
				: '화면을 불러오지 못했습니다'
	);
</script>

<svelte:head><title>{title} — 위키비키</title></svelte:head>
<main class="page-shell">
	<section class="card empty-state">
		<span class="overline">{page.status}</span>
		<h1>{title}</h1>
		<p>{page.error?.message || '문서를 불러오지 못했습니다.'}</p>
		<div class="button-row" style="justify-content:center">
			<a class="secondary-button" href="/">홈으로 이동</a>{#if page.status >= 500}<a
					class="primary-button"
					href={page.url.pathname + page.url.search}
					data-sveltekit-reload>다시 시도</a
				>{/if}
		</div>
	</section>
</main>
