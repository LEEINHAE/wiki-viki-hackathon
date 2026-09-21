<script>
	import { page } from '$app/state';
	import SearchBox from './SearchBox.svelte';
	let { onwikify } = $props();
	let menu = $state(false);
	const home = $derived(page.url.pathname === '/' && !page.url.searchParams.has('q'));
</script>

<header class="topbar">
	<div class="nav-wrap">
		<a class="brand" href="/" aria-label="위키비키 홈"
			><span class="brand-mark">W</span><span>위키비키</span></a
		>
		<nav class:expanded={menu} aria-label="주요 메뉴">
			<a href="/recent" onclick={() => (menu = false)}>최근 변경</a>
			<a
				href="/wikify"
				onclick={(event) => {
					event.preventDefault();
					menu = false;
					onwikify();
				}}>AI 위키파이어</a
			>
			<a href="/drafts" onclick={() => (menu = false)}>초안 검토</a>
		</nav>
		<div class="nav-spacer"></div>
		{#if !home}<SearchBox compact initial={page.url.searchParams.get('q') || ''} {onwikify} />{/if}
		<div class="identity" title="익명 편집자"><span>07</span><b>Operator-07</b></div>
		<button
			class="mobile-menu"
			onclick={() => (menu = !menu)}
			aria-expanded={menu}
			aria-label="메뉴 열기">☰</button
		>
	</div>
</header>
