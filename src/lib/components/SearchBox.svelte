<script>
	import { goto } from '$app/navigation';
	import { docUrl } from '$lib/wiki-utils.js';
	let { compact = false, initial = '', onwikify = () => {} } = $props();
	let query = $state('');
	let suggestions = $state([]);
	let focused = $state(false);
	let selected = $state(-1);
	let problem = $state('');
	let loading = $state(false);
	const uid = $props.id();
	$effect(() => {
		query = initial;
	});
	$effect(() => {
		const q = query.trim();
		selected = -1;
		problem = '';
		if (!q) {
			suggestions = [];
			loading = false;
			return;
		}
		suggestions = [];
		loading = true;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
					signal: controller.signal
				});
				if (!response.ok)
					throw new Error('검색 제안을 불러오지 못했습니다. 검색 버튼으로 다시 시도해 주세요.');
				const results = await response.json();
				if (!controller.signal.aborted) suggestions = results;
			} catch (error) {
				if (!controller.signal.aborted) problem = error.message;
			} finally {
				if (!controller.signal.aborted) loading = false;
			}
		}, 180);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
	function search(event) {
		event.preventDefault();
		focused = false;
		if (query.trim()) goto(`/?q=${encodeURIComponent(query.trim())}`);
	}
	function keydown(event) {
		if (event.key === 'Escape') {
			focused = false;
			selected = -1;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focused = true;
			selected = Math.min(selected + 1, suggestions.length - 1);
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			selected = Math.max(-1, selected - 1);
		}
		if (event.key === 'Enter' && focused && selected >= 0) {
			event.preventDefault();
			focused = false;
			goto(docUrl(suggestions[selected]));
		}
	}
</script>

<div
	class:compact
	class="searchbox"
	onfocusout={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) focused = false;
	}}
>
	<form action="/" method="GET" onsubmit={search} role="search">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"
			><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg
		>
		<input
			name="q"
			bind:value={query}
			onfocus={() => (focused = true)}
			onkeydown={keydown}
			placeholder={compact ? '용어 검색' : '예: RFCC, 산단스팀, 교대 인수인계'}
			aria-label="문서 검색"
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={focused && !!query.trim()}
			aria-controls={`${uid}-suggestions`}
			aria-activedescendant={selected >= 0 ? `${uid}-${selected}` : undefined}
			autocomplete="off"
			required
		/>
		{#if !compact}<button class="primary-button">검색</button>{/if}
	</form>
	{#if focused && query.trim()}
		<div class="suggestions" id={`${uid}-suggestions`}>
			<div role="listbox" aria-label="검색 제안">
				{#each suggestions as item, index}
					<a
						id={`${uid}-${index}`}
						class:selected={selected === index}
						role="option"
						aria-selected={selected === index}
						href={docUrl(item)}
						onclick={() => (focused = false)}
					>
						<strong>{item.title}</strong><span>{item.description}</span><small
							>{item.isDraft ? 'AI 초안' : item.field}</small
						>
					</a>
				{:else}<p class="suggestion-empty" role="status">
						{loading ? '검색 중…' : problem || '일치하는 문서가 없습니다. 새 지식을 더해 주세요.'}
					</p>{/each}
			</div>
			<button
				type="button"
				class="suggestion-create"
				onclick={() => {
					focused = false;
					onwikify();
				}}>「{query}」 문서가 없다면 — 기존 자료를 올려 초안 만들기</button
			>
		</div>
	{/if}
</div>
