<script>
	let { title, heading = 'h2', label, framed = false, children, actions } = $props();
</script>

<div class="empty-state" class:panel={framed}>
	{#if label}<span class="eyebrow">{label}</span>{/if}
	{#if title}<svelte:element this={heading}>{title}</svelte:element>{/if}
	<div class="empty-description">{@render children?.()}</div>
	{#if actions}<div class="button-row">{@render actions()}</div>{/if}
</div>
