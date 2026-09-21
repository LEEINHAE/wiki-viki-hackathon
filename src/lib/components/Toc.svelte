<script>
	let { items = [] } = $props();
	let collapsed = $state(false);
	const listId = $props.id();
	let baseLevel = $derived(Math.min(...items.map((item) => item.level)));
</script>

{#if items.length}<nav class="toc" aria-label="목차">
		<div class="toc-title">
			목차 <button
				onclick={() => (collapsed = !collapsed)}
				aria-expanded={!collapsed}
				aria-controls={listId}>{collapsed ? '펼치기' : '접기'}</button
			>
		</div>
		<ol id={listId} hidden={collapsed}>
			{#each items as item}<li style={`--toc-level:${item.level - baseLevel}`}>
					<a href={`#${item.id}`}><span>{item.number}.</span> {item.title}</a>
				</li>{/each}
		</ol>
	</nav>{/if}
