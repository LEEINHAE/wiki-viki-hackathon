<script>
	import { getContext } from 'svelte';
	let { children, class: className = 'primary-button' } = $props();
	const open = getContext('open-wikifier');
</script>

<a
	href="/wikify"
	class={className}
	onclick={(event) => {
		if (open && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
			event.preventDefault();
			open();
		}
	}}>{@render children()}</a
>
