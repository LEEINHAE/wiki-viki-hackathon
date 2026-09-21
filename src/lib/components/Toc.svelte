<script>
	let { items = [], activeId, onselect, showTitle = true, collapsible = true } = $props();
	let collapsed = $state(false);
	const listId = $props.id();
	let baseLevel = $derived(Math.min(...items.map((item) => item.level)));
</script>

{#if items.length}<nav class="toc" aria-label="목차">
		{#if showTitle}<div class="toc-title">
				목차 {#if collapsible}<button
						type="button"
						onclick={() => (collapsed = !collapsed)}
						aria-expanded={!collapsed}
						aria-controls={listId}>{collapsed ? '펼치기' : '접기'}</button
					>{/if}
			</div>{/if}
		<ol id={listId} hidden={showTitle && collapsible && collapsed}>
			{#each items as item}<li style={`--toc-level:${item.level - baseLevel}`}>
					<a
						href={`#${item.id}`}
						aria-current={activeId === item.id ? 'location' : undefined}
						onclick={(event) => onselect?.(event, item)}><span>{item.number}.</span> {item.title}</a
					>
				</li>{/each}
		</ol>
	</nav>{/if}
