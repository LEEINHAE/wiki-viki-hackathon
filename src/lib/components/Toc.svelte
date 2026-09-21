<script>
	let { items = [] } = $props();
</script>

{#if items.length}<nav class="toc" aria-label="목차">
		<div class="toc-title">목차 <span>[숨기기]</span></div>
		<ol>
			{#each items as item}<li style={`--toc-level:${item.level}`}>
					<a href={`#${item.id}`}><span>{item.number}.</span> {item.title}</a>
				</li>{/each}
		</ol>
	</nav>{/if}
