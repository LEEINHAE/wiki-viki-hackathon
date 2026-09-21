<script>
	import { setContext } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import Header from '$lib/components/Header.svelte';
	import Wikifier from '$lib/components/Wikifier.svelte';
	import '../app.css';
	let { children } = $props();
	let dialog;
	function openWikifier() {
		dialog?.showModal();
	}
	function closeWikifier() {
		dialog?.close();
	}
	setContext('openWikifier', openWikifier);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<Header onwikify={openWikifier} />
{@render children()}
<footer class="site-footer">
	<div>
		<p>본 위키는 사내 전용이며 외부 반출을 금지합니다.</p>
		<p>문의: 사내 협업툴 #wikibiki-support 채널</p>
		<div class="footer-links">
			<a href="/wiki/wiki-viki:basic-policy">이용 원칙</a><a href="/wiki/wiki-viki:help">도움말</a
			><a href="/edit/새-문서">새 문서 작성</a>
		</div>
	</div>
</footer>
<dialog
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
	onclose={() => {}}
>
	<Wikifier onclose={closeWikifier} />
</dialog>
