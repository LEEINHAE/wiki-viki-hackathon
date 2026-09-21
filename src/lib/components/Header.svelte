<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import SearchBox from './SearchBox.svelte';
	import Icon from './Icon.svelte';
	import WikifyButton from './WikifyButton.svelte';
	let dark = $state(false);
	onMount(() => {
		dark = document.documentElement.dataset.theme === 'dark';
		try {
			dark = localStorage.getItem('wiki-theme') === 'dark';
		} catch {
			/* Keep the initial theme when storage is unavailable. */
		}
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
	});
	function toggleTheme() {
		dark = !dark;
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		try {
			localStorage.setItem('wiki-theme', dark ? 'dark' : 'light');
		} catch {
			/* Storage may be disabled. */
		}
	}
</script>

<header class="topbar">
	<div class="nav-wrap">
		<a class="brand" href="/" aria-label="위키비키 홈"
			><span class="brand-mark">W</span><span>위키비키</span></a
		>
		<nav aria-label="주요 메뉴">
			<a
				href="/?view=activity"
				aria-current={page.url.searchParams.get('view') === 'activity' ? 'page' : undefined}
				>최근 변경</a
			><WikifyButton class="nav-link">AI 위키파이어</WikifyButton><a
				href="/drafts"
				aria-current={page.url.pathname === '/drafts' ? 'page' : undefined}>초안 검토</a
			>
		</nav>
		<div class="header-tools">
			{#if page.url.pathname !== '/' || page.url.searchParams.has('q')}<SearchBox
					compact
					initial={page.url.searchParams.get('q') || ''}
				/>{/if}
			<button
				class="theme-button"
				onclick={toggleTheme}
				aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'}
				title={dark ? '라이트 모드' : '다크 모드'}
				><Icon name={dark ? 'sun' : 'moon'} size={18} /></button
			>
			<div class="editor-badge" title="기본 익명 편집자 표시입니다. 로그인 계정이 아닙니다.">
				<span>01</span><b>Editor-01</b>
			</div>
		</div>
	</div>
</header>
