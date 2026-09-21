<script>
	import { goto } from '$app/navigation';
	import { documentHref } from '$lib/knowledge.js';
	import Icon from './Icon.svelte';
	let { initial = '', compact = false } = $props();
	let query = $state('');
	let focused = $state(false);
	let results = $state([]);
	let loading = $state(false);
	let selected = $state(-1);
	const uid = $props.id();
	$effect(() => {
		query = initial;
	});
	$effect(() => {
		const q = query.trim();
		selected = -1;
		results = [];
		if (!q || !focused) {
			loading = false;
			return;
		}
		const controller = new AbortController();
		loading = true;
		const timer = setTimeout(async () => {
			try {
				const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
					signal: controller.signal
				});
				const body = await response.json();
				if (!controller.signal.aborted) results = body.results || [];
			} catch {
				/* The search form still works if suggestions are unavailable. */
			} finally {
				if (!controller.signal.aborted) loading = false;
			}
		}, 200);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
	function submit(event) {
		event.preventDefault();
		focused = false;
		if (query.trim()) goto(`/?q=${encodeURIComponent(query.trim())}`);
	}
	function keydown(event) {
		if (event.key === 'Escape') {
			focused = false;
			selected = -1;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			focused = true;
			selected = Math.max(
				-1,
				Math.min(results.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))
			);
		}
		if (event.key === 'Enter' && focused && selected >= 0 && results[selected]) {
			event.preventDefault();
			focused = false;
			goto(documentHref(results[selected].slug));
		}
	}
</script>

<div
	class:compact
	class="search-box"
	onfocusout={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) focused = false;
	}}
>
	<form method="GET" action="/" role="search" onsubmit={submit}>
		<span class="search-icon"><Icon size={compact ? 18 : 24} /></span>
		<input
			name="q"
			bind:value={query}
			maxlength="200"
			aria-label={compact ? '용어 검색' : '위키 문서 검색'}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={focused && !!query.trim()}
			aria-controls={`${uid}-suggestions`}
			aria-activedescendant={selected >= 0 ? `${uid}-suggestion-${selected}` : undefined}
			autocomplete="off"
			placeholder={compact ? '용어 검색' : '예: RFCC, 산단스팀, 교대 인수인계'}
			onfocus={() => (focused = true)}
			onkeydown={keydown}
		/>
		<button class="primary-button" aria-label="검색"
			>{#if compact}<Icon size={16} name="arrow" />{:else}검색{/if}</button
		>
	</form>
	{#if focused && query.trim()}
		<div class="suggestions">
			<ul id={`${uid}-suggestions`} role="listbox" aria-label="추천 문서">
				{#each results as result, index}<li
						role="option"
						aria-selected={selected === index}
						id={`${uid}-suggestion-${index}`}
					>
						<a href={documentHref(result.slug)} onclick={() => (focused = false)}
							><strong>{result.title}</strong><span>{result.excerpt}</span><small
								>{result.category}</small
							></a
						>
					</li>{:else}<li class="suggestion-empty" role="presentation">
						{loading ? '문서를 찾는 중…' : '추천 문서가 없습니다. 검색으로 더 찾아보세요.'}
					</li>{/each}
			</ul>
			<a class="suggestion-create" href="/wikify"
				>찾는 문서가 없다면 — 기존 자료로 초안 만들기 <span>↗</span></a
			>
		</div>
	{/if}
</div>
