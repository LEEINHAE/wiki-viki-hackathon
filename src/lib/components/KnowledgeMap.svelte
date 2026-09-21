<script>
	import EmptyState from './EmptyState.svelte';
	import StatusNotice from './StatusNotice.svelte';
	import { navigating } from '$app/state';
	import { documentHref, knowledgeMapHref } from '$lib/knowledge.js';
	let { graph } = $props();
	const center = $derived(graph.nodes[0]);
	const loading = $derived(
		navigating.to?.url.pathname === '/' && navigating.to.url.searchParams.get('view') === 'map'
	);
	const connectionLabel = (node) =>
		node.incoming && node.outgoing
			? '서로 연결'
			: node.outgoing
				? '중심 문서에서 연결'
				: '중심 문서를 가리킴';
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

{#if graph.centerUnavailable}
	<StatusNotice tone="warning"
		>선택한 문서를 찾을 수 없습니다. 현재 조회할 수 있는 문서를 기준으로 지도를 표시합니다.</StatusNotice
	>
{/if}
{#if center}
	<form class="map-select" method="GET" action="/#knowledge-map" data-sveltekit-noscroll>
		<input type="hidden" name="view" value="map" />
		<div class="field">
			<label for="map-center-select">중심 문서</label>
			<select id="map-center-select" name="center" value={center.slug}>
				{#each graph.documents as document}<option value={document.slug}>{document.title}</option
					>{/each}
			</select>
		</div>
		<button class="secondary-button">연결 보기</button>
	</form>
	<p class="map-summary small" aria-live="polite" aria-atomic="true">
		현재 중심: <strong>{center.title}</strong> · 연결된 문서 {graph.neighborCount}개
	</p>
{/if}
{#if loading}<StatusNotice tone="pending" role="status"
		>연결된 문서를 불러오고 있습니다.</StatusNotice
	>{/if}
<div class="knowledge-map" aria-busy={loading}>
	{#if nodes.length}
		<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"
			>{#each edges as edge}<line
					x1={edge.source.x}
					y1={edge.source.y}
					x2={edge.target.x}
					y2={edge.target.y}
				/>{/each}</svg
		>
		{#each nodes as node, i (node.slug)}<a
				class="map-node"
				class:map-center={i === 0}
				style={`left:${node.x}%;top:${node.y}%`}
				href={i === 0 ? documentHref(node.slug) : knowledgeMapHref(node.slug)}
				data-sveltekit-noscroll={i !== 0}
				data-sveltekit-keepfocus={i !== 0}
				aria-label={i === 0 ? `${node.title} 문서 열기` : `${node.title} 중심으로 연결 보기`}
				title={i === 0 ? '문서 열기' : '이 문서를 중심으로 연결 보기'}
				><span class="map-node-title">{node.title}</span><small
					>{i === 0 ? '문서 열기 ↗' : `${node.links}개의 역링크`}</small
				></a
			>{/each}
	{:else}<EmptyState
			><p>문서를 작성하고 [[위키 링크]]로 연결하면 여기에 지식 지도가 나타납니다.</p></EmptyState
		>{/if}
</div>
{#if center}
	{#if graph.neighborCount}
		<nav class="map-connections" aria-label="지도에 표시된 연결 문서">
			<h3>연결된 문서</h3>
			<p class="small muted">
				{graph.neighborCount}개 중 {(graph.page - 1) * 6 + 1}–{Math.min(
					graph.page * 6,
					graph.neighborCount
				)}개 표시 · 항목을 선택해 계속 탐색하세요.
			</p>
			<ul>
				{#each nodes.slice(1) as node (node.slug)}<li>
						<a href={knowledgeMapHref(node.slug)} data-sveltekit-noscroll
							><strong>{node.title}</strong><span>{connectionLabel(node)} →</span></a
						>
					</li>{/each}
			</ul>
		</nav>
		{#if graph.pages > 1}<nav class="map-pagination" aria-label="연결 문서 페이지">
				{#if graph.page > 1}<a
						class="secondary-button"
						href={knowledgeMapHref(center.slug, graph.page - 1)}
						data-sveltekit-noscroll>← 이전 연결</a
					>{/if}
				<span>{graph.page} / {graph.pages}</span>
				{#if graph.page < graph.pages}<a
						class="secondary-button"
						href={knowledgeMapHref(center.slug, graph.page + 1)}
						data-sveltekit-noscroll>다음 연결 →</a
					>{/if}
			</nav>{/if}
	{:else}<p class="small muted">
			이 문서와 연결된 다른 문서는 없습니다. 중심 문서를 바꿔 다른 연결을 살펴보세요.
		</p>{/if}
{/if}

<style>
	.map-select {
		display: flex;
		align-items: end;
		flex-wrap: wrap;
		gap: 0.65rem;
		margin-top: 1rem;
	}
	.map-select .field {
		flex: 1 1 10rem;
		min-width: 0;
		margin: 0;
	}
	.map-node:not(.map-center) {
		width: max-content;
	}
	.map-summary {
		overflow-wrap: anywhere;
	}
	.map-node-title {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
	}
	.map-center .map-node-title {
		-webkit-line-clamp: 4;
		line-clamp: 4;
	}
	.map-connections h3 {
		font-size: 1rem;
		margin-bottom: 0.5rem;
	}
	.map-connections ul {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.map-connections a {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem;
		border: 1px solid var(--line);
		border-radius: var(--inset-radius);
		overflow-wrap: anywhere;
	}
	.map-connections strong {
		font-size: 0.9rem;
	}
	.map-connections span {
		font-size: 0.8rem;
		color: var(--secondary);
	}
	.map-pagination {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		margin: 1rem 0;
	}
	@media (max-width: 480px) {
		.map-connections ul {
			grid-template-columns: 1fr;
		}
	}
</style>
