<script>
	import { page } from '$app/state';
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	const title = $derived(
		page.status === 404 ? '페이지를 찾을 수 없습니다.' : '페이지를 불러오지 못했습니다.'
	);
</script>

<svelte:head><title>{title} — 위키비키</title></svelte:head>

<main class="form-page work-page">
	<section class="wiki-form">
		<header class="document-header">
			<p class="eyebrow">오류 {page.status}</p>
			<h1>{title}</h1>
		</header>
		<StatusNotice tone="error" role="alert">
			<p>{page.error?.message || '요청한 화면을 표시할 수 없습니다.'}</p>
			<p>
				{page.status === 404
					? '주소를 확인하거나 홈에서 문서를 검색해 주세요.'
					: '잠시 후 다시 불러오거나 홈에서 다른 문서를 찾아보세요.'}
			</p>
		</StatusNotice>
		<div class="button-row">
			<a
				class="primary-button"
				href={page.url.pathname + page.url.search + page.url.hash}
				data-sveltekit-reload>다시 불러오기</a
			>
			<a class="secondary-button" href="/">홈으로</a>
		</div>
	</section>
</main>
