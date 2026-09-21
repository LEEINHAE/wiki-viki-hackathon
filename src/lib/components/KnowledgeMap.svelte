<script>
	let { graph } = $props();
	const nodes = $derived.by(() => {
		const sorted = [...graph.documents].sort((a, b) => b.count - a.count);
		if (!sorted.length) return [];
		const center = sorted[0];
		const linked = new Set(
			graph.edges
				.filter((edge) => edge.from === center.slug || edge.to === center.slug)
				.flatMap((edge) => [edge.from, edge.to])
		);
		const around = sorted
			.slice(1)
			.sort((a, b) => Number(linked.has(b.slug)) - Number(linked.has(a.slug)))
			.slice(0, 6);
		return [
			{ ...center, x: 50, y: 49, center: true },
			...around.map((doc, i) => ({
				...doc,
				x: 50 + 34 * Math.cos((-Math.PI * 5) / 6 + (i * Math.PI) / 3),
				y: 49 + 36 * Math.sin((-Math.PI * 5) / 6 + (i * Math.PI) / 3)
			}))
		];
	});
	const edges = $derived(
		graph.edges.flatMap((edge) => {
			const from = nodes.find((node) => node.slug === edge.from);
			const to = nodes.find((node) => node.slug === edge.to);
			return from && to ? [{ from, to }] : [];
		})
	);
</script>

<div class="knowledge-map" aria-label="문서 연결 지도">
	{#if nodes.length}
		<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
			{#each edges as edge}<line
					x1={edge.from.x}
					y1={edge.from.y}
					x2={edge.to.x}
					y2={edge.to.y}
				/>{/each}
		</svg>
		{#each nodes as node}<a
				class="map-node"
				class:center={node.center}
				href={`/wiki/${encodeURIComponent(node.slug)}`}
				style={`left:${node.x}%;top:${node.y}%`}
				title={node.title}>{node.title.replace(/^(?:Sample:|Wiki Viki:)/, '')}</a
			>{/each}
	{:else}<div class="empty-state">
			첫 문서를 만들면 지식 지도가 시작됩니다.<a href="/edit/새-문서">문서 만들기 →</a>
		</div>{/if}
</div>
