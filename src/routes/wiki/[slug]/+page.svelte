<script>
	import { getContext } from 'svelte';
	import { docUrl, relativeTime } from '$lib/wiki-utils.js';
	import ReadingTools from '$lib/components/ReadingTools.svelte';
	import Toc from '$lib/components/Toc.svelte';
	import { permits, canAccessRoute } from '$lib/auth-policy.js';
	import { reviewLabels } from '$lib/search.js';
	let { data } = $props();
	let articleElement = $state();
	const openWikifier = getContext('openWikifier');
	const canEdit = $derived(data.demo || permits(data.user?.role, 'editor'));
	const canReview = $derived(canAccessRoute(data.user?.role, '/manage/[slug]'));
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
			<article bind:this={articleElement}>
				{#if data.redirectedFrom}<div class="notice">
						「{data.redirectedFrom}」에서 넘어왔습니다.
					</div>{/if}
				{#if data.mergedFrom}<div class="notice">
						「{data.mergedFrom.title}」가 이 문서에 병합되었습니다.
						<a href={`/history/${encodeURIComponent(data.mergedFrom.slug)}`}>원본 문서 역사</a> ·
						<a href={`/discussion/${encodeURIComponent(data.mergedFrom.slug)}`}>원본 토론</a>
					</div>{/if}
				{#if data.revision}<div class="notice">
						리비전 {data.revision.id} · {new Date(data.revision.created_at).toLocaleString(
							'ko-KR'
						)}의 본문입니다. {data.revision.hasMetadata
							? ''
							: '당시 메타데이터 기록이 없어 제목·별칭은 현재 값입니다.'}
						<a href={`/wiki/${encodeURIComponent(data.document.slug)}`}>최신 문서 보기</a>
					</div>{/if}
				<h1 class="article-title">{data.document.title}</h1>
				<p>
					<span class="tag"
						>{reviewLabels[data.document.governance?.reviewState] || '검토 필요'}</span
					>
				</p>
				{#if data.document.description}<p>{data.document.description}</p>{/if}
				{#if data.document.aliases.length}<p class="article-aliases">
						{data.document.aliases.join(' · ')}
					</p>{/if}
				<div class="tag-list">
					{#each data.document.tags as tag}<a
							class="tag"
							href={`/?browse=1&tag=${encodeURIComponent(tag)}`}>{tag}</a
						>{/each}
				</div>
				<div class="article-meta">
					<span
						>최근 수정 {relativeTime(data.document.updated_at)} · {data.document
							.editor_handle}</span
					>
					<nav aria-label="문서 메뉴">
						{#if canAccessRoute(data.user?.role, '/proposals/[slug]')}<a
								class="secondary-button"
								href={`/proposals/${encodeURIComponent(data.document.slug)}`}>수정 제안</a
							>{/if}
						{#if canEdit}<a
								class="primary-button"
								href={`/edit/${encodeURIComponent(data.document.slug)}`}>편집</a
							>{/if}{#if canReview}<a
								class="secondary-button"
								href={`/manage/${encodeURIComponent(data.document.slug)}`}>검토·관리</a
							>{/if}<a
							class="secondary-button"
							href={`/history/${encodeURIComponent(data.document.slug)}`}>역사</a
						><a
							class="secondary-button"
							href={`/discussion/${encodeURIComponent(data.document.slug)}`}>토론 {data.threads}</a
						>
					</nav>
				</div>
				{#key `${data.document.id}:${data.revision?.id || data.document.version}`}<ReadingTools
						documentId={data.document.id}
						slug={data.document.slug}
						revisionId={data.revision?.id}
						element={articleElement}
						readOnly={!!data.revision || !canEdit}
					/>{/key}
				<div class="mobile-toc"><Toc items={data.toc} /></div>
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
				<div class="desktop-toc"><Toc items={data.toc} /></div>
				<section class="card related-card">
					<h4>연결된 용어</h4>
					<p>본문에서 이어지는 문서</p>
					{#each data.document.related as doc}<a class="list-link" href={docUrl(doc)}
							><span>{doc.title}</span><small>{doc.field}</small></a
						>{:else}<p class="muted">아직 연결된 용어가 없습니다.</p>{/each}
				</section>
				<section class="card">
					<h4>검토 정보</h4>
					<p>담당자 {data.ownerHandle || '미지정'}</p>
					<p>
						마지막 검토 {data.document.wv_reviewed_at
							? new Date(data.document.wv_reviewed_at).toLocaleDateString('ko-KR')
							: '기록 없음'}
					</p>
					<p>다음 검토 {data.document.wv_next_review_on?.slice(0, 10) || '미지정'}</p>
					<h4>출처</h4>
					<div class="source-text">
						{data.document.source_name || '출처 미등록'}
					</div>
					{#each data.sources || [] as source}<details>
							<summary>{source.file_name} · {source.label}</summary>
							<pre class="source-excerpt">{source.text}</pre>
						</details>{/each}
				</section>
			</aside>
		</div>
	{/if}
</main>
