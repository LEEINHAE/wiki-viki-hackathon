<script>
	import { documentHref } from '$lib/knowledge.js';
	let { items, incoming = false } = $props();
</script>

<ul class="document-connections" role="list">
	{#each items as doc (doc.id)}
		<li>
			<a
				class="connection-link"
				class:related-link={!incoming}
				href={documentHref(doc.slug)}
				aria-describedby={`${incoming ? 'incoming' : 'outgoing'}-connection-${doc.id}`}
				>{doc.title}{incoming ? ' ↗' : ''}</a
			>
			<p class="connection-category">{doc.category}</p>
			<p
				class="connection-reason"
				id={`${incoming ? 'incoming' : 'outgoing'}-connection-${doc.id}`}
			>
				<span class="connection-kind"
					>{doc.connection.automatic ? '제목·별칭 자동 연결' : '본문에 저장된 링크'}</span
				>
				{#if doc.connection.label}<span>본문 표기: “{doc.connection.label}”</span>{/if}
			</p>
		</li>
	{/each}
</ul>

<style>
	.document-connections {
		list-style: none;
		margin: 12px 0;
		padding: 0;
	}
	li {
		border-top: 1px solid var(--line);
		padding: 8px 0 12px;
		overflow-wrap: anywhere;
	}
	.connection-link {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-size: 14px;
		font-weight: 600;
		line-height: 1.6;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	p {
		margin: 0;
		color: var(--secondary);
		font-size: 12px;
		line-height: 1.7;
	}
	.connection-reason {
		margin-top: 4px;
	}
	.connection-reason span {
		display: block;
	}
	.connection-kind {
		font-weight: 600;
	}
</style>
