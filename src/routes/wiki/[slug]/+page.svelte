<script>
	import RecentSidebar from '$lib/components/RecentSidebar.svelte';
	import Toc from '$lib/components/Toc.svelte';
	let { data } = $props();
</script>

<svelte:head><title>{data.missing ? '문서를 찾을 수 없음' : data.document.title} — Wiki Viki</title></svelte:head>
<div class="site-grid"><main class="wiki-paper">
	{#if data.missing}
		<header class="document-header"><h1>{decodeURIComponent(data.slug).replaceAll('-', ' ')}</h1><div class="document-meta">아직 존재하지 않는 문서입니다.</div></header>
		<div class="notice warning">요청한 문서가 아직 만들어지지 않았습니다. 제목을 확인하거나 새 문서를 작성해 주세요.</div>
		<div class="button-row"><a class="primary-button" href={`/edit/${data.slug}`}>문서 만들기</a></div>
	{:else}
		<header class="document-header"><h1>{data.document.title}</h1><div class="document-meta"><span>최근 수정: {new Date(data.document.updated_at).toLocaleString('ko-KR')}</span><span>작성자: {data.document.editor_handle}</span></div></header>
		<nav class="document-actions"><a href={`/edit/${data.document.slug}`}>편집</a><a href={`/history/${data.document.slug}`}>역사</a><a href={`/discussion/${data.document.slug}`}>토론</a></nav>
		{#if data.redirectedFrom}<div class="redirect-notice"><b>{data.redirectedFrom}</b>에서 넘어왔습니다.</div>{/if}
		<Toc items={data.toc} />
		<article class="wiki-content">{@html data.html}</article>
		<section class="backlinks"><h2>이 문서를 가리키는 문서</h2>{#if data.backlinks.length}<ul>{#each data.backlinks as item}<li><a href={`/wiki/${item.slug}`}>{item.title}</a></li>{/each}</ul>{:else}<p class="muted">이 문서를 가리키는 문서가 없습니다.</p>{/if}</section>
	{/if}
</main><RecentSidebar changes={data.changes} /></div>
