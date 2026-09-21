<script>
	import { setContext } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import favicon from '$lib/assets/favicon.svg';
	import Header from '$lib/components/Header.svelte';
	import WikifyForm from '$lib/components/WikifyForm.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import '../app.css';
	let { children } = $props();
	let pointerDownOutside = false;
	let dialog;
	let wikifierStarted = $state(false);
	setContext('open-wikifier', () => {
		wikifierStarted = true;
		dialog.showModal();
	});
	function close() {
		dialog?.close();
	}
	function isBackdrop(event) {
		if (event.target !== dialog) return false;
		const { left, right, top, bottom } = dialog.getBoundingClientRect();
		return (
			event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom
		);
	}
	afterNavigate(close);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<a class="skip-link" href="#main-content">본문으로 바로가기</a>
<Header />
<div id="main-content">{@render children()}</div>
<footer class="site-footer">
	<div><span class="footer-brand">W</span><span>함께 기록하고, 연결하고, 성장하는 지식.</span></div>
	<div>
		<a href="/wiki/wiki-viki:basic-policy">이용 원칙</a><a href="/wiki/wiki-viki:help">도움말</a
		><span>Wiki Viki © {new Date().getFullYear()}</span>
	</div>
</footer>
<dialog
	bind:this={dialog}
	class="wikifier-dialog"
	aria-label="AI 위키파이어"
	onpointerdown={(event) => {
		pointerDownOutside = isBackdrop(event);
	}}
	onpointercancel={() => (pointerDownOutside = false)}
	onpointerup={(event) => {
		const pointerUpOutside = isBackdrop(event);

		if (pointerDownOutside && pointerUpOutside) {
			close();
		}

		pointerDownOutside = false;
	}}
>
	<div class="dialog-toolbar">
		<button class="modal-close theme-button" aria-label="위키파이어 닫기" onclick={close}
			><Icon name="close" /></button
		>
	</div>
	<div class="dialog-inner">
		{#if wikifierStarted}<WikifyForm oncomplete={close} inModal />{/if}
	</div>
</dialog>
