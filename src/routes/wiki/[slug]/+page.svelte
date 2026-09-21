<script>
	import Toc from '$lib/components/Toc.svelte';
	import { documentHref, formatDate } from '$lib/knowledge.js';
	let { data } = $props();
</script>

<svelte:head>
	<title
		>{data.missing ? data.pendingDraft?.title || '아직 없는 문서' : data.document.title} — 위키비키</title
	>
</svelte:head>
<main class="page-shell article-page">
	{#if data.missing}<section class="panel empty-state">
			<span class="eyebrow">{data.pendingDraft ? '검토 중인 지식' : '아직 기록되지 않은 지식'}</span
			>
			<h1>{data.pendingDraft?.title || decodeURIComponent(data.slug).replaceAll('-', ' ')}</h1>
			{#if data.pendingDraft}
				<p>
					이 문서는 아직 게시되지 않았지만 검토 중인 초안이 있습니다. 내용을 확인하고 다듬어 주세요.
				</p>
				<a class="primary-button" href={`/drafts?open=${data.pendingDraft.id}`}>초안 열어보기 →</a>
			{:else}
				<p>이 문서는 아직 작성되지 않았습니다. 아는 것을 한 문단으로 남겨 보세요.</p>
				<a class="primary-button" href={`/edit/${encodeURIComponent(data.slug)}`}>첫 문장 쓰기 →</a>
			{/if}<a class="secondary-button" href="/">홈으로</a>
		</section>
	{:else}
		<nav class="breadcrumbs" aria-label="현재 위치">
			<a href="/">위키비키</a><span>/</span><span>{data.category}</span><span>/</span><span
				>{data.document.title}</span
			>
		</nav>
		<div class="article-grid">
			<article class="article-main">
				<header class="article-header">
					<h1>{data.document.title}</h1>
					{#if data.aliases.length}<p class="article-aliases">{data.aliases.join(' · ')}</p>{/if}
					<div class="article-toolbar">
						<div class="document-meta">
							최근 수정 {formatDate(data.document.updated_at)} · {data.document.editor_handle}
						</div>
						<nav class="document-actions" aria-label="문서 작업">
							<a href={`/edit/${encodeURIComponent(data.document.slug)}`}>편집</a><a
								href={`/history/${encodeURIComponent(data.document.slug)}`}>역사</a
							><a href={`/discussion/${encodeURIComponent(data.document.slug)}`}
								>토론 {data.threads}</a
							>
						</nav>
					</div>
				</header>
				{#if data.redirectedFrom}<div class="redirect-notice">
						<b>{data.redirectedFrom}</b>에서 연결된 문서입니다.
					</div>{/if}
				{#if data.toc.length}<div class="mobile-toc"><Toc items={data.toc} /></div>{/if}
				<div class="wiki-content">{@html data.html}</div>
				<div class="contribute-banner">
					<div>
						<h3>아는 것이 있다면 5분만</h3>
						<p>한 문장만 고쳐도 됩니다. {data.contributors}명의 편집자가 함께 만든 문서입니다.</p>
					</div>
					<a class="primary-button" href={`/edit/${encodeURIComponent(data.document.slug)}`}
						>한 줄 고치기 ↗</a
					>
				</div>
				<section class="backlinks">
					<h2>이 문서를 가리키는 문서 <span class="tag">{data.backlinks.length}</span></h2>
					<div class="chips">
						{#each data.backlinks as doc}<a class="chip" href={documentHref(doc.slug)}
								>{doc.title} ↗</a
							>{:else}<p class="muted small">아직 이 문서를 가리키는 문서가 없습니다.</p>{/each}
					</div>
				</section>
			</article>
			<aside class="article-aside">
				<section class="panel">
					<Toc items={data.toc} />{#if !data.toc.length}<h3>문서 안내</h3>
						<p class="small muted">이 문서에는 아직 목차가 없습니다.</p>{/if}
				</section>
				<section class="panel">
					<h3>함께 읽으면 좋은 문서</h3>
					{#each data.related as doc}<a class="related-link" href={documentHref(doc.slug)}
							>{doc.title}<small>{doc.category}</small></a
						>{:else}<p class="muted small">
							본문에 위키 링크를 추가해 지식을 연결해 주세요.
						</p>{/each}
				</section>
				<p class="source-note">
					누구나 고칠 수 있고, 모든 변경은 기록됩니다. 문서의 역사를 통해 지식이 쌓인 과정을
					확인하세요.
				</p>
			</aside>
		</div>
	{/if}
</main>
