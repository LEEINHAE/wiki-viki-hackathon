<script>
	let { changes = [] } = $props();
</script>

<aside class="recent-sidebar">
	<h2>최근 변경</h2>
	<ul>
		{#each changes as item}<li>
				<a href={`/wiki/${item.slug}`}>{item.title}</a><time
					>{new Date(item.updated_at).toLocaleDateString('ko-KR', {
						month: '2-digit',
						day: '2-digit'
					})}</time
				>
			</li>
		{:else}<li class="muted">최근 변경 내역이 없습니다.</li>{/each}
	</ul>
	<a class="aside-more" href="/wiki/wiki-viki:최근-변경">모든 변경 내역 보기 →</a>
</aside>
