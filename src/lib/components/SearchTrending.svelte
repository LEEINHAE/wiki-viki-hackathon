<script>
	import { onMount } from 'svelte';
	import { recordSearch } from '$lib/trending.js';
	let items = $state([]),
		loading = $state(true),
		problem = $state(''),
		updatedAt = $state('');
	onMount(() => {
		let active = true,
			controller,
			pending = false;
		async function refresh() {
			if (pending || document.hidden) return;
			pending = true;
			controller = new AbortController();
			try {
				const response = await fetch('/api/trending', { signal: controller.signal });
				if (!response.ok) throw Error();
				const data = await response.json();
				if (active) {
					items = data.items;
					updatedAt = data.updatedAt;
					problem = '';
				}
			} catch {
				if (active) problem = '순위를 불러오지 못했습니다. 잠시 후 다시 확인합니다.';
			} finally {
				pending = false;
				if (active) loading = false;
			}
		}
		refresh();
		const timer = setInterval(refresh, 30000);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			active = false;
			clearInterval(timer);
			controller?.abort();
			document.removeEventListener('visibilitychange', refresh);
		};
	});
</script>

<section class="search-trending" aria-label="실시간 검색어 순위">
	<div class="trending-title">
		<h2>최근 트렌딩 <span>실시간 검색어</span></h2>
		<small>최근 1시간 · 30초마다 갱신</small>
	</div>
	{#if problem}<p role="status" class="muted">{problem}</p>{:else if loading}<p class="muted">
			검색어 순위를 불러오는 중…
		</p>{:else if !items.length}<p class="muted">
			아직 집계된 검색어가 없습니다. 검색하면 순위에 반영됩니다.
		</p>{/if}
	{#if items.length}<ol>
			{#each items as item (item.query)}<li>
					<a href={`/?q=${encodeURIComponent(item.query)}`} onclick={() => recordSearch(item.query)}
						><b>{item.rank}</b><span>{item.query}</span><small>{item.count}회</small></a
					>
				</li>{/each}
		</ol>{/if}
	<small class="muted"
		>검색 결과가 있는 검색어 기준 · 같은 이용자의 반복 검색은 5분에 한 번 반영{#if updatedAt}
			· {new Date(updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 갱신{/if}</small
	>
</section>

<style>
	.search-trending {
		margin: 24px 0;
		padding: 20px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--reading);
		text-align: left;
	}
	.trending-title {
		display: flex;
		gap: 12px;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	h2 {
		font-size: 18px;
		margin: 0;
	}
	h2 span {
		font-size: 13px;
		font-weight: 400;
		color: var(--muted);
		margin-left: 8px;
	}
	ol {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 24px;
		padding: 0;
		list-style: none;
		margin: 12px 0;
	}
	a {
		display: flex;
		gap: 12px;
		padding: 8px 0;
		align-items: center;
		color: var(--text);
		text-decoration: none;
		min-width: 0;
	}
	a:hover span {
		text-decoration: underline;
	}
	b {
		color: var(--accent);
		min-width: 18px;
	}
	a span {
		flex: 1;
		overflow-wrap: anywhere;
	}
	small {
		font-size: 12px;
	}
	a small {
		color: var(--muted);
		white-space: nowrap;
	}
	@media (max-width: 540px) {
		ol {
			grid-template-columns: 1fr;
		}
		.search-trending {
			padding: 16px;
		}
	}
</style>
