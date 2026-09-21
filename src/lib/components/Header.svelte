<script>
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import SearchBox from './SearchBox.svelte';
	import { permits, canAccessRoute } from '$lib/auth-policy.js';
	let { onwikify } = $props();
	let menu = $state(false);
	let dark = $state(false);
	const canEdit = $derived(page.data.demo || permits(page.data.user?.role, 'editor'));
	onMount(() => {
		dark = document.documentElement.dataset.theme === 'dark';
	});
	function toggleTheme() {
		dark = !dark;
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		try {
			localStorage.setItem('wiki-theme', dark ? 'dark' : 'light');
		} catch {}
	}
	const home = $derived(
		page.url.pathname === '/' &&
			!page.url.searchParams.has('q') &&
			!page.url.searchParams.has('browse')
	);
</script>

<header class="topbar">
	<div class="nav-wrap">
		<a class="brand" href="/" aria-label="위키비키 홈"
			><span class="brand-mark">W</span><span>위키비키</span></a
		>
		<nav class:expanded={menu} aria-label="주요 메뉴">
			<a href="/?view=search" onclick={() => (menu = false)}>검색</a>
			<a href="/?browse=1" onclick={() => (menu = false)}>문서 탐색</a>
			<a href="/recent" onclick={() => (menu = false)}>최근 변경</a>
			{#if canEdit}
				<a
					href="/wikify"
					onclick={(event) => {
						event.preventDefault();
						menu = false;
						onwikify();
					}}>AI 위키파이어</a
				>
				<a href="/uploads" onclick={() => (menu = false)}>업로드 작업</a>
				<a href="/drafts" onclick={() => (menu = false)}>초안 검토</a>
				<a href="/edit/새-문서" onclick={() => (menu = false)}>새 문서</a>
			{/if}
		</nav>
		<div class="nav-spacer"></div>
		{#if !home}<SearchBox compact initial={page.url.searchParams.get('q') || ''} {onwikify} />{/if}
		<button
			class="icon-button theme-toggle"
			onclick={toggleTheme}
			aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'}>{dark ? '☀' : '◐'}</button
		>
		{#if page.data.demo}<span
				class="identity"
				title="개발 환경에서는 로그인 없이 사용할 수 있습니다.">개발 모드</span
			>{/if}
		{#if page.data.user}<details class="account-menu">
				<summary>{page.data.user.handle}</summary>
				<div class="card">
					<p>
						{page.data.user.role === 'admin'
							? '운영'
							: page.data.user.role === 'reviewer'
								? '검토'
								: page.data.user.role === 'editor'
									? '편집'
									: '읽기'} 계정
					</p>
					<a href="/account">내 계정</a><a href="/library">내 문서</a><a href="/collections"
						>문서 묶음</a
					><a href="/notifications">내 알림</a
					>{#if canAccessRoute(page.data.user.role, '/reviews')}<a href="/reviews">정기 검토</a
						>{/if}{#if page.data.user.role === 'admin'}<a href="/admin/users">계정 관리</a>{/if}
					<form action="/logout" method="POST">
						<button class="secondary-button">로그아웃</button>
					</form>
				</div>
			</details>{:else if !page.data.demo}<a href="/login">로그인</a>{/if}
		<button
			class="mobile-menu"
			onclick={() => (menu = !menu)}
			aria-expanded={menu}
			aria-label="메뉴 열기">☰</button
		>
	</div>
</header>
