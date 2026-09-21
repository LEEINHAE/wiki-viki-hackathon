<script>
	let { items = [] } = $props();
	let collapsed = $state(false);
</script>

{#if items.length}<nav class="toc" aria-label="목차">
		<div class="toc-title">
			목차 <button onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed}
				>{collapsed ? '펼치기 +' : '접기 −'}</button
			>
		</div>
		<ol hidden={collapsed}>
			{#each items as item}<li style={`--toc-level:${item.level}`}>
					<a href={`#${item.id}`}><span>{item.number}.</span> {item.title}</a>
				</li>{/each}
		</ol>
	</nav>{/if}
