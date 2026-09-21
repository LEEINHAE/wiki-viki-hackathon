<script>
	let query = $state('');
	let dark = $state(false);
	function search(event) {
		event.preventDefault();
		if (query.trim()) location.href = `/?q=${encodeURIComponent(query.trim())}`;
	}
	function toggleTheme() {
		dark = !dark;
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		localStorage.setItem('wiki-theme', dark ? 'dark' : 'light');
	}
</script>

<svelte:window
	on:load={() => {
		dark = localStorage.getItem('wiki-theme') === 'dark';
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
	}}
/>
<header class="topbar">
	<div class="nav-wrap">
		<a class="brand" href="/"><span class="brand-mark">W</span><span>Wiki Viki</span></a>
		<nav aria-label="주요 메뉴">
			<a href="/wiki/wiki-viki:최근-변경">최근 변경</a><a href="/wikify">AI 위키 변환</a><a
				href="/drafts">검토 대기 초안</a
			>
		</nav>
		<form class="nav-search" onsubmit={search}>
			<input bind:value={query} aria-label="Wiki Viki 문서 검색" placeholder="검색" /><button
				aria-label="검색">⌕</button
			>
		</form>
		<button class="theme-button" onclick={toggleTheme} aria-label="다크 모드 전환"
			>{dark ? '☀' : '☾'}</button
		>
	</div>
</header>
