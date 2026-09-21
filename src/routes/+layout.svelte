<script>
	import favicon from '$lib/assets/favicon.svg';
	import Header from '$lib/components/Header.svelte';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Header />
{@render children()}
<footer class="site-footer"><div>Wiki Viki · 함께 작성하고 성장하는 사내 지식.</div><div><a href="/wiki/wiki-viki:기본-정책">이용 원칙</a> · <a href="/wiki/wiki-viki:도움말">도움말</a></div></footer>
