<script>
	import { getContext } from 'svelte';
	import { docUrl, relativeTime } from '$lib/wiki-utils.js';
	import Toc from '$lib/components/Toc.svelte';
	let { data } = $props();
	const openWikifier = getContext('openWikifier');
	$effect(() => {
		if (data.missing) return;
		const slug = data.document.slug;
		try {
			const key = `wiki-view:${slug}`;
			if (sessionStorage.getItem(key)) return;
			fetch('/api/views', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slug })
			})
				.then((response) => {
					if (response.ok) sessionStorage.setItem(key, '1');
				})
				.catch(() => {});
		} catch {
			/* Storage may be unavailable in private browsing. */
		}
	});
</script>

<svelte:head
	><title>{data.missing ? '아직 없는 문서' : data.document.title} — 위키비키</title></svelte:head
>
<main class="page-shell">
	{#if data.missing}<div class="breadcrumbs">
			<a href="/">위키비키</a><span>/</span><span>새 문서</span>
		</div>
		<section class="card empty-state">
			<h1>{data.slug.replaceAll('-', ' ')}</h1>
			<p>아직 작성되지 않은 문서입니다. 알고 있는 내용을 더해 주세요.</p>
			<div class="button-row" style="justify-content:center">
				<a class="primary-button" href={`/edit/${encodeURIComponent(data.slug)}`}
					>빈 문서로 새로 쓰기</a
				><button class="secondary-button" onclick={openWikifier}>기존 자료로 초안 만들기</button>
			</div>
		</section>
	{:else}
		<div class="breadcrumbs">
			<a href="/">위키비키</a><span>/</span><span>{data.document.field}</span><span>/</span><strong
				>{data.document.title}</strong
			>
		</div>
		<div class="article-grid">
			<article>
				{#if data.redirectedFrom}<div class="notice">
						「{data.redirectedFrom}」에서 넘어왔습니다.
					</div>{/if}
				<h1 class="article-title">{data.document.title}</h1>
				{#if data.document.aliases.length}<p class="article-aliases">
						{data.document.aliases.join(' · ')}
					</p>{/if}
				<div class="article-meta">
					<span
						>최근 수정 {relativeTime(data.document.updated_at)} · {data.document.editor_handle} · 조회
						{Number(data.document.views || 0).toLocaleString('ko-KR')}</span
					>
					<nav aria-label="문서 메뉴">
						<a class="primary-button" href={`/edit/${encodeURIComponent(data.document.slug)}`}
							>편집</a
						><a class="secondary-button" href={`/history/${encodeURIComponent(data.document.slug)}`}
							>역사</a
						><a
							class="secondary-button"
							href={`/discussion/${encodeURIComponent(data.document.slug)}`}>토론 {data.threads}</a
						>
					</nav>
				</div>
				<div class="wiki-content">{@html data.html}</div>
				<section class="edit-invitation">
					<div>
						<h3>아는 것이 있다면 5분만</h3>
						<p>한 문장만 고쳐도 됩니다. 이 문서는 {data.contributors}명이 함께 작성했습니다.</p>
					</div>
					<a class="primary-button" href={`/edit/${encodeURIComponent(data.document.slug)}`}
						>한 줄 고치기</a
					>
				</section>
				<section class="backlinks">
					<h3>이 문서를 링크한 문서 (역링크 {data.document.backlinks.length})</h3>
					<div class="tag-list">
						{#each data.document.backlinks as doc}<a class="tag tag-outline" href={docUrl(doc)}
								>{doc.title}</a
							>{:else}<p class="muted">
								다른 문서에서 이 문서를 연결하면 여기에 표시됩니다.
							</p>{/each}
					</div>
				</section>
			</article>
			<aside class="article-aside">
				<Toc items={data.toc} />
				<section class="card related-card">
					<h4>연결된 용어</h4>
					<p>본문에서 이어지는 문서</p>
					{#each data.document.related as doc}<a class="list-link" href={docUrl(doc)}
							><span>{doc.title}</span><small>{doc.field}</small></a
						>{:else}<p class="muted">아직 연결된 용어가 없습니다.</p>{/each}
				</section>
				<section class="card">
					<h4>출처</h4>
					<div class="source-text">
						{data.document.source_name || '구성원이 직접 작성한 위키 문서'}
					</div>
				</section>
			</aside>
		</div>
	{/if}
</main>
