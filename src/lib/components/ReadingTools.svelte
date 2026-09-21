<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { rememberDocument, readLibrary, toggleFavorite } from '$lib/personalization.js';
	let { documentId, element, readOnly = false, slug = '', revisionId = null } = $props();
	let size = $state(18);
	let width = $state('normal');
	let favorite = $state(false);
	let subscribed = $state(false);
	let saving = $state(false);
	let problem = $state('');
	let copied = $state('');
	function apply() {
		if (element) {
			element.style.setProperty('--reading-font', `${size}px`);
			element.style.setProperty('--reading-width', width === 'wide' ? '100%' : '72ch');
		}
	}
	function load() {
		try {
			const p = JSON.parse(localStorage.getItem('wiki-reading') || '{}');
			size = [16, 18, 20, 22].includes(p.size) ? p.size : 18;
			width = p.width === 'wide' ? 'wide' : 'normal';
			if (!page.data.user)
				favorite = readLibrary().favorites.some((d) => String(d.id) === String(documentId));
		} catch {
			problem = '읽기 설정을 저장할 수 없어 기본값을 사용합니다.';
		}
		apply();
	}
	function save() {
		apply();
		try {
			localStorage.setItem('wiki-reading', JSON.stringify({ size, width }));
		} catch {
			problem = '이 브라우저에서 설정을 저장하지 못했습니다.';
		}
	}
	async function updatePersonal(action, value = true) {
		const res = await fetch('/api/personal', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action, documentId, value })
		});
		const result = await res.json();
		if (!res.ok) throw Error(result.message);
		window.dispatchEvent(new Event('wiki-library-change'));
	}
	async function star() {
		if (saving) return;
		saving = true;
		try {
			if (page.data.user) {
				await updatePersonal('favorite', !favorite);
				favorite = !favorite;
			} else favorite = toggleFavorite(documentId);
		} catch (cause) {
			problem = cause.message || '즐겨찾기를 저장하지 못했습니다.';
		} finally {
			saving = false;
		}
	}
	async function subscribe() {
		if (saving) return;
		saving = true;
		try {
			await updatePersonal('subscribe', !subscribed);
			subscribed = !subscribed;
		} catch (cause) {
			problem = cause.message || '구독을 저장하지 못했습니다.';
		} finally {
			saving = false;
		}
	}
	async function accountState() {
		try {
			const res = await fetch(`/api/personal?id=${documentId}`);
			if (!res.ok) throw Error('계정 문서 상태를 불러오지 못했습니다.');
			const state = await res.json();
			favorite = state.favorite;
			subscribed = state.subscribed;
			await updatePersonal('visit');
		} catch (cause) {
			problem = cause.message;
		}
	}

	async function copy(text) {
		try {
			await navigator.clipboard.writeText(text);
			copied = '복사했습니다.';
		} catch {
			copied = '복사하지 못했습니다. 주소창 또는 본문을 직접 복사해 주세요.';
		}
	}
	onMount(() => {
		load();
		if (page.data.user) accountState();
		else
			try {
				rememberDocument(documentId);
			} catch {
				problem = '최근 본 문서를 저장하지 못했습니다.';
			}
		window.addEventListener('wiki-reading-change', load);
		return () => window.removeEventListener('wiki-reading-change', load);
	});
	$effect(() => {
		element;
		size;
		width;
		apply();
	});
	$effect(() => {
		if (!element) return;
		const controls = [];
		for (const heading of element?.querySelectorAll(
			'.wiki-content h1[id],.wiki-content h2[id],.wiki-content h3[id],.wiki-content h4[id],.wiki-content h5[id],.wiki-content h6[id]'
		) || []) {
			const headingLabel = heading.textContent;
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'paragraph-copy';
			button.textContent = '링크';
			button.setAttribute('aria-label', `${headingLabel} 문단 링크 복사`);
			button.onclick = () => {
				const url = new URL(location.href);
				url.hash = heading.id;
				copy(url.href);
			};
			heading.append(button);
			controls.push(button);
			if (!readOnly) {
				const link = document.createElement('a');
				link.className = 'paragraph-copy';
				link.textContent = '편집';
				link.href = `/edit/${encodeURIComponent(slug)}?section=${encodeURIComponent(heading.id)}`;
				link.setAttribute('aria-label', `${headingLabel} 문단 편집`);
				heading.append(link);
				controls.push(link);
			}
		}
		for (const block of element?.querySelectorAll('.wiki-content pre') || []) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'code-copy secondary-button';
			button.textContent = '코드 복사';
			button.onclick = () => copy(block.querySelector('code')?.textContent || '');
			block.before(button);
			controls.push(button);
		}
		return () => controls.forEach((button) => button.remove());
	});
</script>

<div class="reading-tools" aria-label="읽기 설정">
	<button
		class="secondary-button"
		aria-pressed={favorite}
		onclick={star}
		aria-disabled={saving}
		aria-busy={saving}>{favorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기'}</button
	>
	{#if page.data.user}<button
			class="secondary-button"
			onclick={subscribe}
			aria-pressed={subscribed}
			aria-disabled={saving}
			aria-busy={saving}>{subscribed ? '구독 해제' : '변경 알림 구독'}</button
		>{/if}
	<label
		>글자 크기 <select bind:value={size} onchange={save}
			><option value={16}>작게</option><option value={18}>기본</option><option value={20}
				>크게</option
			><option value={22}>더 크게</option></select
		></label
	>
	<label
		>읽기 폭 <select bind:value={width} onchange={save}
			><option value="normal">기본</option><option value="wide">넓게</option></select
		></label
	>
	<button class="secondary-button" onclick={() => window.print()}>인쇄</button>
	<a
		href={`/api/export/${encodeURIComponent(slug)}${revisionId ? `?revision=${revisionId}` : ''}`}
		download>Markdown·메타데이터 내보내기</a
	><a href="/library">저장 정보 관리</a>
	{#if problem}<p class="notice warning" role="status">{problem}</p>{/if}<span
		class="muted"
		role="status">{copied}</span
	>
</div>
