<script>
	import { setContext, onDestroy } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { permits } from '$lib/auth-policy.js';
	import favicon from '$lib/assets/favicon.svg';
	import Header from '$lib/components/Header.svelte';
	import Wikifier from '$lib/components/Wikifier.svelte';
	import '../app.css';
	let { children } = $props();
	const canEdit = $derived(page.data.demo || permits(page.data.user?.role, 'editor'));
	let dialog = $state();
	let previousOverflow = '';
	function openWikifier() {
		previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		dialog?.showModal();
	}
	function closeWikifier() {
		dialog?.close();
	}
	function releaseScroll() {
		if (typeof document !== 'undefined') document.body.style.overflow = previousOverflow;
	}
	afterNavigate(closeWikifier);
	onDestroy(releaseScroll);
	setContext('openWikifier', openWikifier);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<a class="skip-link" href="#main-content">본문 바로가기</a>
<Header onwikify={openWikifier} />
<div id="main-content" tabindex="-1">{@render children()}</div>
<footer class="site-footer">
	<div>
		<p>본 위키는 사내 전용이며 외부 반출을 금지합니다.</p>
		<p>문의: 사내 협업툴 #wikibiki-support 채널</p>
		<div class="footer-links">
			<a href="/wiki/wiki-viki:basic-policy">이용 원칙</a><a href="/wiki/wiki-viki:help">도움말</a
			>{#if canEdit}<a href="/edit/새-문서">새 문서 작성</a>{/if}
			{#if page.data.demo || page.data.user?.role === 'admin'}<a href="/trash">휴지통</a>{/if}
		</div>
	</div>
</footer>
{#if canEdit}<dialog
		class="modal"
		bind:this={dialog}
		aria-label="AI 위키파이어"
		onclick={(event) => {
			if (event.target === dialog) {
				const rect = dialog.getBoundingClientRect();
				if (
					event.clientX < rect.left ||
					event.clientX > rect.right ||
					event.clientY < rect.top ||
					event.clientY > rect.bottom
				)
					closeWikifier();
			}
		}}
		onclose={releaseScroll}
	>
		<Wikifier onclose={closeWikifier} />
	</dialog>
{/if}
