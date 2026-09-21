<script>
	import { docUrl } from '$lib/wiki-utils.js';
	let { graph, field = '' } = $props();
	const nodes = $derived.by(() => {
		if (!graph.documents.length) return [];
		const center = graph.documents.find((d) => d.slug === graph.center) || graph.documents[0];
		const around = graph.documents.filter((d) => d.slug !== center.slug).slice(0, 6);
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
				href={`/?view=map&center=${encodeURIComponent(node.slug)}&field=${encodeURIComponent(field)}`}
				style={`left:${node.x}%;top:${node.y}%`}
				title={node.title}>{node.title.replace(/^(?:Sample:|Wiki Viki:)/, '')}</a
			>{/each}
	{:else}<div class="empty-state">
			첫 문서를 만들면 지식 지도가 시작됩니다.<a href="/edit/새-문서">문서 만들기 →</a>
		</div>{/if}
</div>

{#if nodes.length}<section class="map-list" aria-label="지도와 같은 문서 연결 목록">
		<h3>「{nodes[0].title}」 중심 연결</h3>
		<p>노드를 누르면 그 문서를 중심으로 탐색합니다. 최대 6개 이웃을 표시합니다.</p>
		<a href={docUrl(nodes[0])}>중심 문서 읽기 →</a>
		<ul>
			{#each nodes.slice(1) as node}<li>
					<a href={docUrl(node)}>{node.title}</a>
					· {node.incoming ? '중심 문서를 인용' : ''}{node.incoming && node.outgoing
						? ' / '
						: ''}{node.outgoing ? '중심 본문에서 연결' : ''} ·
					<a
						href={`/?view=map&center=${encodeURIComponent(node.slug)}&field=${encodeURIComponent(field)}`}
						>이 문서 중심</a
					>
				</li>{:else}<li>연결된 이웃이 없습니다.</li>{/each}
		</ul>
	</section>{/if}
