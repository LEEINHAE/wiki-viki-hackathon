<script>
	let { items = [] } = $props();
	let collapsed = $state(false);
</script>

{#if items.length}<nav class="card toc" aria-label="목차">
		<div class="section-title">
			<h4>목차</h4>
			<button
				class="icon-button"
				aria-label={collapsed ? '목차 펼치기' : '목차 접기'}
				aria-expanded={!collapsed}
				onclick={() => (collapsed = !collapsed)}>{collapsed ? '+' : '−'}</button
			>
		</div>
		{#if !collapsed}<ol>
				{#each items as item}<li style={`--toc-level:${Math.max(1, item.level - 1)}`}>
						<a href={`#${item.id}`}>{item.title}</a>
					</li>{/each}
			</ol>{/if}
	</nav>{/if}
