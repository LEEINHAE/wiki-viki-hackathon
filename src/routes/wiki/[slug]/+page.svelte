<script>
	import Toc from '$lib/components/Toc.svelte';
	import { documentHref } from '$lib/knowledge.js';
	let { data } = $props();
	const modifiedDate = new Intl.DateTimeFormat('ko-KR', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'Asia/Seoul'
	});
</script>

<svelte:head>
	<title
		>{data.missing ? data.pendingDraft?.title || '아직 없는 문서' : data.document.title} — 위키비키</title
	>
</svelte:head>
<main class="page-shell article-page" id="article-top">
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
					{#if data.aliases.length}<p class="article-aliases">
							<span>다른 이름</span>
							{data.aliases.join(' · ')}
						</p>{/if}
					<p class="document-meta">
						최근 수정 시각: <time datetime={new Date(data.document.updated_at).toISOString()}
							>{modifiedDate.format(new Date(data.document.updated_at))}</time
						>
					</p>
				</header>
				<nav class="article-tabs" aria-label="문서 작업">
					<a class="current" href={documentHref(data.document.slug)} aria-current="page">문서</a>
					<a href={`/discussion/${encodeURIComponent(data.document.slug)}`}
						>토론 <span class="tab-count">{data.threads}</span></a
					>
					<a class="article-edit" href={`/edit/${encodeURIComponent(data.document.slug)}`}>편집</a>
					<a href={`/history/${encodeURIComponent(data.document.slug)}`}>역사</a>
				</nav>
				<div class="article-category"><span>분류</span><strong>{data.category}</strong></div>
				{#if data.redirectedFrom}<div class="redirect-notice">
						<b>{data.redirectedFrom}</b>에서 연결된 문서입니다.
					</div>{/if}
				{#if data.toc.length}<div class="article-toc" id="document-toc">
						<Toc items={data.toc} />
					</div>{/if}
				<div class="wiki-content">{@html data.html}</div>
				<div class="contribute-banner">
					<div>
						<h3>함께 다듬는 지식</h3>
						<p>
							{data.contributors}명의 편집자가 함께 만든 문서입니다. 더 나은 설명을 보태 주세요.
						</p>
					</div>
					<a class="primary-button" href={`/edit/${encodeURIComponent(data.document.slug)}`}
						>문서 편집</a
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
				<a class="article-back-top" href="#article-top">맨 위로 ↑</a>
			</article>
			<aside class="article-aside">
				<section class="article-side-section">
					<h2>관련 문서</h2>
					{#each data.related as doc}<a class="related-link" href={documentHref(doc.slug)}
							>{doc.title}<small>{doc.category}</small></a
						>{:else}<p class="muted small">
							본문에 위키 링크를 추가해 지식을 연결해 주세요.
						</p>{/each}
				</section>
				<section class="article-side-section article-info">
					<h2>문서 정보</h2>
					<dl>
						<div>
							<dt>마지막 편집</dt>
							<dd>{data.document.editor_handle}</dd>
						</div>
						<div>
							<dt>참여한 편집자</dt>
							<dd>{data.contributors}명</dd>
						</div>
						<div>
							<dt>연결된 문서</dt>
							<dd>{data.backlinks.length}개</dd>
						</div>
					</dl>
					<a href={`/history/${encodeURIComponent(data.document.slug)}`}>변경 이력 보기 →</a>
				</section>
				<p class="source-note">
					누구나 고칠 수 있고, 모든 변경은 기록됩니다. 문서의 역사를 통해 지식이 쌓인 과정을
					확인하세요.
				</p>
			</aside>
		</div>
	{/if}
</main>
