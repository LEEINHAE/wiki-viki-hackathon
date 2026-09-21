<script>
	import { docUrl, relativeTime } from '$lib/wiki-utils.js';
	let { discussions = [] } = $props();
</script>

<section class="card recent-discussions" aria-labelledby="recent-discussions-title">
	<div class="section-title">
		<h2 id="recent-discussions-title">최근 시작된 토론</h2>
		<span class="muted">최근 5건</span>
	</div>
	{#if discussions.length}
		<ul>
			{#each discussions as item (item.id)}
				<li>
					<div>
						<a
							class="discussion-title"
							href={`/discussion/${encodeURIComponent(item.slug)}?thread=${item.id}#thread-${item.id}`}
							>{item.thread_title}</a
						>
						<a class="document-link" href={docUrl(item)}>{item.title} · 문서 읽기</a>
					</div>
					<time datetime={new Date(item.created_at).toISOString()}
						>{relativeTime(item.created_at)}</time
					>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted">아직 시작된 토론이 없습니다. 문서의 ‘토론’에서 의견을 나눠 보세요.</p>
	{/if}
</section>

<style>
	.recent-discussions {
		margin-bottom: 20px;
	}
	.section-title {
		gap: 12px;
	}
	h2 {
		font-size: 18px;
	}
	.section-title > span {
		flex-shrink: 0;
		font-size: 12px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
	}
	li + li {
		border-top: 1px solid var(--line);
	}
	li > div {
		min-width: 0;
	}
	.discussion-title {
		display: block;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.document-link {
		display: inline-block;
		margin-top: 4px;
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	time {
		flex-shrink: 0;
		color: var(--muted);
		font-size: 12px;
	}
	@media (max-width: 480px) {
		li {
			align-items: flex-start;
			flex-direction: column;
			gap: 4px;
		}
	}
</style>
