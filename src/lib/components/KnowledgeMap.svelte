<script>
	import EmptyState from './EmptyState.svelte';
	import { documentHref } from '$lib/knowledge.js';
	let { graph } = $props();
	const positions = [
		[50, 49],
		[20, 17],
		[80, 18],
		[16, 61],
		[84, 63],
		[33, 86],
		[67, 87]
	];
	const nodes = $derived(
		graph.nodes.map((node, index) => ({ ...node, x: positions[index][0], y: positions[index][1] }))
	);
	const edges = $derived(
		graph.edges.map((edge) => ({
			source: nodes.find((n) => n.slug === edge.source),
			target: nodes.find((n) => n.slug === edge.target)
		}))
	);
</script>

<div class="knowledge-map">
	{#if nodes.length}
		<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"
			>{#each edges as edge}<line
					x1={edge.source.x}
					y1={edge.source.y}
					x2={edge.target.x}
					y2={edge.target.y}
				/>{/each}</svg
		>
		{#each nodes as node, i}<a
				class="map-node"
				class:map-center={i === 0}
				style={`left:${node.x}%;top:${node.y}%`}
				href={documentHref(node.slug)}
				title={node.title}>{node.title}<small>{node.links}개의 역링크</small></a
			>{/each}
	{:else}<EmptyState
			><p>문서를 작성하고 [[위키 링크]]로 연결하면 여기에 지식 지도가 나타납니다.</p></EmptyState
		>{/if}
</div>
