<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { readLibrary, clearPersonalization, toggleFavorite } from '$lib/personalization.js';
	let { compact = false } = $props();
	let library = $state({ favorites: [], recent: [], subscriptions: [] });
	let problem = $state('');
	let loading = $state(true);
	let controller;
	async function load() {
		controller?.abort();
		const active = new AbortController();
		controller = active;
		loading = true;
		problem = '';
		try {
			if (page.data.user) {
				const res = await fetch('/api/personal', { signal: active.signal });
				const data = await res.json();
				if (!res.ok) throw Error(data.message);
				if (!active.signal.aborted) library = data;
				return;
			}
			const stored = readLibrary();
			const ids = [...new Set([...stored.favorites, ...stored.recent].map((item) => item.id))];
			const res = await fetch('/api/library', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ids }),
				signal: active.signal
			});
			const rows = await res.json();
			if (!res.ok) throw Error(rows.message);
			if (active.signal.aborted) return;
			const resolve = (items) =>
				items.map((item) => rows.find((row) => String(row.id) === String(item.id))).filter(Boolean);
			library = {
				favorites: resolve(stored.favorites),
				recent: resolve(stored.recent),
				subscriptions: []
			};
		} catch (cause) {
			if (!active.signal.aborted)
				problem = cause.message || '브라우저 저장소에 접근할 수 없습니다.';
		} finally {
			if (!active.signal.aborted) loading = false;
		}
	}
	onMount(() => {
		load();
		window.addEventListener('wiki-library-change', load);
		window.addEventListener('storage', load);
		return () => {
			controller?.abort();
			window.removeEventListener('wiki-library-change', load);
			window.removeEventListener('storage', load);
		};
	});
	async function clear() {
		try {
			if (page.data.user) {
				await updateAccount({ action: 'clear' });
			}
			clearPersonalization();
		} catch {
			problem = '브라우저 저장소에 접근할 수 없습니다.';
		}
	}
	async function updateAccount(values) {
		const res = await fetch('/api/personal', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(values)
		});
		if (!res.ok) throw Error();
		await load();
		window.dispatchEvent(new Event('wiki-library-change'));
	}
	async function remove(id, group = 'favorites') {
		try {
			if (page.data.user)
				await updateAccount({
					action: group === 'subscriptions' ? 'subscribe' : 'favorite',
					documentId: id,
					value: false
				});
			else toggleFavorite(id);
		} catch {
			problem = '즐겨찾기를 변경하지 못했습니다.';
		}
	}
</script>

<section class="card personal-library" aria-label="내 문서 목록">
	<h2>
		{compact
			? '내 문서 바로가기'
			: page.data.user
				? '내 계정의 문서 목록'
				: '이 브라우저의 문서 목록'}
	</h2>
	<p class="muted">
		{page.data.user
			? '현재 계정에 저장되어 같은 계정으로 로그인한 기기에서 볼 수 있습니다.'
			: '현재 브라우저에만 저장됩니다.'} 최근 본 문서는 30일·최대 30개, 즐겨찾기는 최대 100개입니다. 문서
		본문과 검색어는 저장하지 않습니다.
	</p>
	{#if loading}<p role="status">문서 상태 확인 중…</p>{:else if problem}<p
			class="notice warning"
			role="alert"
		>
			{problem}
		</p>
		<button class="secondary-button" onclick={load}>다시 시도</button>{:else}
		<div class="personal-columns">
			{#each [{ key: 'favorites', label: '즐겨찾기' }, { key: 'recent', label: '최근 본 문서' }, ...(page.data.user ? [{ key: 'subscriptions', label: '구독' }] : [])] as group}<section
				>
					<h3>{group.label}</h3>
					<ul>
						{#each library[group.key].slice(0, compact ? 5 : 100) as doc}<li>
								<a href={`/wiki/${encodeURIComponent(doc.slug)}`}>{doc.title}</a
								>{#if !compact && ['favorites', 'subscriptions'].includes(group.key)}
									<button
										class="secondary-button"
										onclick={() => remove(doc.id, group.key)}
										aria-label={`${doc.title} ${group.label} 해제`}>해제</button
									>{/if}
							</li>{:else}<li class="muted">
								아직 저장된 문서가 없습니다. 문서를 읽거나 별표 버튼으로 추가하세요.
							</li>{/each}
					</ul>
				</section>{/each}
		</div>
	{/if}
	{#if compact}<a href="/library">전체 목록·저장 정보 관리 →</a>{:else}<p class="muted">
			삭제·휴지통 문서는 표시하지 않습니다. 아래 초기화는 즐겨찾기·최근 문서·읽기 설정{page.data
				.user
				? '·구독·알림'
				: ''}을 모두 지웁니다.
		</p>
		<button class="danger-button" onclick={clear}
			>{page.data.user ? '내 계정의 저장 정보와 브라우저 읽기 설정' : '이 브라우저의 개인화 정보'} 모두
			삭제</button
		>{/if}
</section>
