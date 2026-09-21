<script>
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { documentHref, knowledgeMapHref, formatDate } from '$lib/knowledge.js';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import AnswerCard from '$lib/components/AnswerCard.svelte';
	import KnowledgeMap from '$lib/components/KnowledgeMap.svelte';
	import WikifyButton from '$lib/components/WikifyButton.svelte';
	import { navigating, page } from '$app/state';
	let { data } = $props();
	const loadingDocuments = $derived(
		navigating.to?.url.pathname === '/' &&
			!navigating.to.url.searchParams.get('q')?.trim() &&
			navigating.to.url.searchParams.get('view') === 'search'
	);
	let category = $state('전체');
	$effect(() => {
		data.q;
		category = '전체';
	});
	const categories = $derived([...new Set(data.results.map((doc) => doc.category))]);
	const filtered = $derived(
		data.results.filter((doc) => category === '전체' || doc.category === category)
	);
	const categoryHref = (name) =>
		`/?view=search${name === '전체' ? '' : '&category=' + encodeURIComponent(name)}#home-documents`;
	const views = [
		{ id: 'search', label: '검색 우선', note: '찾는 일에 집중하고, 아는 것을 나눠 보세요.' },
		{ id: 'activity', label: '활동 대시보드', note: '함께 쌓아 가는 지식의 변화를 살펴보세요.' },
		{ id: 'map', label: '지식 지도', note: '하나의 문서에서 다음 지식으로 이어집니다.' }
	];
</script>

{#snippet loadFailure(title)}
	<EmptyState {title} framed>
		<p>데이터를 확인하지 못해 목록과 개수를 표시하지 않았습니다. 잠시 후 다시 불러와 주세요.</p>
		{#snippet actions()}
			<a class="secondary-button" href={page.url.pathname + page.url.search} data-sveltekit-reload
				>다시 불러오기</a
			>
		{/snippet}
	</EmptyState>
{/snippet}

<svelte:head
	><title>{data.q ? `「${data.q}」 검색 결과` : '모르는 것은 5초 안에'} — 위키비키</title><meta
		name="description"
		content="검색으로 찾고, 문서로 연결하고, 함께 고치는 사내 지식 위키."
	/></svelte:head
>
<main class="page-shell" class:search-page={!!data.q} class:work-page={!!data.q}>
	{#if !data.databaseReady}<StatusNotice tone="error" role="alert">
			문서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
		</StatusNotice>{/if}
	{#if data.q}
		<header class="results-heading">
			<h1>「{data.q}」 검색 결과</h1>
			<span class="muted">
				{#if data.databaseReady}문서 {data.results.length}건{data.results.length === 40
						? '까지 표시'
						: ''}{:else}문서 수 확인 불가{/if}
			</span>
		</header>
		{#if !data.databaseReady}
			{@render loadFailure('검색 결과를 불러오지 못했습니다.')}
		{:else}
			<div class="content-grid search-grid">
				<div class="stack">
					{#if data.results.length}<AnswerCard query={data.q} />{/if}
					<section class="panel search-results" aria-label="검색된 문서">
						{#each filtered as doc}<article class="search-result">
								<div class="result-title">
									<a href={documentHref(doc.slug)}>{doc.title}</a><span class="muted"
										>{doc.category}</span
									>
								</div>
								<p>{doc.excerpt || '문서를 열어 내용을 확인해 주세요.'}</p>
								<small>{doc.editor_handle} · {formatDate(doc.updated_at)} 수정</small>
							</article>{:else}<EmptyState
								title={data.results.length
									? '이 분야의 문서가 없습니다.'
									: '아직 기록되지 않은 지식이에요.'}
							>
								<p>다른 검색어로 찾아보거나, 첫 문서를 작성해 주세요.</p>
							</EmptyState>{/each}
						<div class="search-create">
							<span>찾는 내용이 없나요?</span><WikifyButton class="secondary-button"
								>기존 자료 올려 초안 만들기</WikifyButton
							><a class="text-link" href={`/new?title=${encodeURIComponent(data.q)}`}
								>빈 문서로 새로 쓰기 ↗</a
							>
						</div>
					</section>
				</div>
				<aside class="stack">
					<section class="panel">
						<h3>분야로 좁히기</h3>
						<p class="small muted">문서 제목을 기준으로 분류했습니다.</p>
						<div class="chips">
							<button
								class="chip"
								class:selected={category === '전체'}
								onclick={() => (category = '전체')}>전체 {data.results.length}</button
							>{#each categories as field}<button
									class="chip"
									class:selected={category === field}
									onclick={() => (category = field)}
									>{field} {data.results.filter((doc) => doc.category === field).length}</button
								>{/each}
						</div>
					</section>
					<section class="panel">
						<h3>함께 살펴볼 문서</h3>
						{#each data.hubs.slice(0, 4) as doc}<a
								class="aside-document"
								href={documentHref(doc.slug)}>{doc.title}<span>↗</span></a
							>{:else}<p class="muted">연결된 문서가 없습니다.</p>{/each}
					</section>
					<a class="back-home" href="/">← 홈으로 돌아가기</a>
				</aside>
			</div>
		{/if}
	{:else}
		<section class="home-search work-page" aria-labelledby="home-title">
			<h1 id="home-title">
				{data.view === 'search'
					? '필요한 지식을 찾아보세요'
					: data.view === 'activity'
						? '최근 변경과 검토할 지식'
						: '문서에서 다음 지식으로'}
			</h1>
			<p>용어·설비·업무 절차를 검색하고, 원문에서 내용을 확인하세요.</p>
			<SearchBox inputId="wiki-search" />
		</section>
		<div class="home-workspace work-page">
			{#if data.view === 'search'}
				<div class="home-start-grid">
					<section class="panel home-fields" aria-labelledby="home-fields-title">
						<h2 id="home-fields-title">분야로 찾아보기</h2>
						<p class="small muted">게시된 문서의 제목을 기준으로 분류했습니다.</p>
						{#if data.databaseReady}
							<nav class="chips" aria-label="문서 분야">
								{#each [{ name: '전체', count: data.stats.documents }, ...data.browse.categories] as field}
									<a
										class="chip"
										class:selected={data.browse.category === field.name}
										href={categoryHref(field.name)}
										aria-current={data.browse.category === field.name ? 'true' : undefined}
										>{field.name} {field.count}</a
									>
								{/each}
							</nav>
						{:else}
							<p class="muted">문서를 불러온 뒤 분야를 확인할 수 있습니다.</p>
						{/if}
					</section>
					<section class="panel home-guide" aria-labelledby="home-guide-title">
						<h2 id="home-guide-title">처음 오셨나요?</h2>
						<ol>
							<li>검색이나 분야에서 문서를 찾아 읽으세요.</li>
							<li>아는 내용은 새 문서로 쓰거나 기존 자료를 올리세요.</li>
							<li>업로드로 만든 초안은 <a href="/drafts">검토한 뒤 게시</a>하세요.</li>
						</ol>
						<div class="home-start-actions">
							<a class="secondary-button" href="/new">새 문서 작성</a>
							<WikifyButton class="secondary-button">기존 자료 올리기</WikifyButton>
						</div>
					</section>
				</div>
			{/if}
			<div class="explore-bar" id="explore">
				<span class="section-label">위키 둘러보기</span>
				<nav class="view-switcher" aria-label="홈 보기">
					{#each views as view}<a
							href={`/?view=${view.id}#explore`}
							aria-current={data.view === view.id ? 'page' : undefined}>{view.label}</a
						>{/each}
				</nav>
				<span class="view-note">{views.find((view) => view.id === data.view).note}</span>
			</div>
			{#if !data.databaseReady && data.view !== 'search'}
				{@render loadFailure(
					data.view === 'activity'
						? '활동 정보를 불러오지 못했습니다.'
						: '문서 연결을 불러오지 못했습니다.'
				)}
			{:else if data.view === 'search'}
				<section
					class="panel home-documents"
					id="home-documents"
					aria-label="분야별 문서 목록"
					aria-busy={loadingDocuments}
				>
					{#if loadingDocuments}
						<StatusNotice tone="pending">선택한 분야의 문서를 불러오고 있습니다.</StatusNotice>
					{/if}
					{#if !data.databaseReady}
						<EmptyState title="문서 목록을 불러오지 못했습니다.">
							<p>
								연결을 확인한 뒤 다시 불러와 주세요. 검색이나 새 문서 작성도 상단에서 시작할 수
								있습니다.
							</p>
							{#snippet actions()}<a
									class="secondary-button"
									href={categoryHref(data.browse.category).split('#')[0]}
									data-sveltekit-reload>다시 불러오기</a
								>{/snippet}
						</EmptyState>
					{:else}
						<h2>
							{data.browse.category === '전체'
								? '최근 수정된 문서'
								: `${data.browse.category} 문서`}
						</h2>
						{#if data.browse.documents.length}
							<p class="small muted">
								{data.browse.total > data.browse.documents.length
									? `${data.browse.total}개 중 최근 수정된 ${data.browse.documents.length}개를 표시합니다.`
									: `최근 수정 순으로 ${data.browse.total}개를 표시합니다.`}
							</p>
							<div class="home-document-list">
								{#each data.browse.documents as doc}
									<a class="home-document" href={documentHref(doc.slug)}>
										<strong>{doc.title}</strong>
										<span>{doc.excerpt || '문서를 열어 내용을 확인해 주세요.'}</span>
										<small>{doc.category} · {formatDate(doc.updated_at)} 수정</small>
									</a>
								{/each}
							</div>
						{:else}
							<EmptyState>
								<p>
									{data.browse.category === '전체'
										? '아직 게시된 문서가 없습니다.'
										: '이 분야의 게시 문서가 없습니다.'}
								</p>
								{#snippet actions()}
									{#if data.browse.category !== '전체'}<a
											class="secondary-button"
											href={categoryHref('전체')}>전체 분야 보기</a
										>{/if}
									<a class="secondary-button" href="/new">첫 문서 작성하기</a>
								{/snippet}
							</EmptyState>
						{/if}
					{/if}
				</section>
				{#if data.hubs.length}
					<div class="trending">
						<span>연결이 많은 용어</span>
						<div class="chips">
							{#each data.hubs as doc}<a class="chip" href={documentHref(doc.slug)}>{doc.title}</a
								>{/each}
						</div>
					</div>
				{/if}
				<section class="home-stats" aria-label="위키 현황">
					<h2>위키 현황</h2>
					<div class="stats-grid">
						{#each [{ key: 'documents', label: '게시된 문서', href: '/?view=activity#explore' }, { key: 'edits', label: '이번 주 편집', href: '/?view=activity#explore' }, { key: 'links', label: '문서 간 연결', href: '/?view=map#explore' }, { key: 'drafts', label: '검토 대기 초안', href: '/drafts' }] as stat, index}<a
								class="stat-card"
								class:olive={index > 1}
								href={stat.href}
								><strong>{data.stats ? data.stats[stat.key].toLocaleString('ko-KR') : '—'}</strong
								><span>{stat.label}</span><span class="stat-arrow" aria-hidden="true">↗</span></a
							>{/each}
					</div>
				</section>
				<section class="home-intro" aria-label="위키비키 소개">
					<div class="hero-badge"><span></span> 사내 자율진화형 지식 위키</div>
					<h2>모르는 것은 5초 안에,<br />아는 것은 5분 안에.</h2>
					<p>
						검색창 하나로 시작합니다. 여러 문서의 지식을 연결해 바로 읽히는 설명을 만듭니다. 필요한
						문서가 없다면 기존 사내 문서를 올려 초안부터 시작하세요.
					</p>
				</section>
				<section class="contribution-panel">
					<div>
						<h2>백지에서<br />시작하지 않습니다</h2>
						<p>
							이미 가지고 있는 문서가 좋은 출발점입니다. AI와 함께 정리하고, 동료와 함께 완성하세요.
						</p>
						<WikifyButton>AI 위키파이어 열기 ↗</WikifyButton>
					</div>
					<div class="contribution-steps">
						{#each [{ title: '기존 문서 올리기', text: '회의록, 설비 매뉴얼, 약어집 PDF' }, { title: 'AI가 초안 작성', text: '용어별 초안으로 나누고 서로 연결' }, { title: '고쳐서 게시', text: '쓰는 일보다 고치는 일이 가볍습니다' }] as step, i}<div
								class="step-card"
							>
								<span>{i + 1}</span>
								<h3>{step.title}</h3>
								<p>{step.text}</p>
							</div>{/each}
					</div>
				</section>
			{:else if data.view === 'activity'}
				<div class="content-grid dashboard-grid">
					<section class="panel">
						<div class="panel-heading">
							<h2>최근 변경</h2>
							<span class="small muted">최근 수정된 문서</span>
						</div>
						<div class="activity-list">
							{#each data.changes as doc}<a class="activity-row" href={documentHref(doc.slug)}
									><div>
										<strong>{doc.title}</strong>
										<p>{doc.excerpt}</p>
									</div>
									<div class="activity-meta">
										<b>{doc.editor_handle}</b><time>{formatDate(doc.updated_at)}</time>
									</div></a
								>{:else}<EmptyState><p>아직 작성된 문서가 없습니다.</p></EmptyState>{/each}
						</div>
					</section>
					<aside class="stack">
						<section class="panel peach-panel">
							<h2>검토를 기다리는 초안</h2>
							<p class="small">함께 완성할 초안 {data.drafts.length}건. 한 문장부터 살펴보세요.</p>
							{#each data.drafts.slice(0, 3) as draft}<a
									class="mini-draft"
									href={`/drafts?open=${draft.id}`}
									><strong>{draft.title}</strong><small
										>{draft.source_name || '직접 작성'} · {draft.status === 'blocked'
											? '확인 필요'
											: '검토 대기'}</small
									></a
								>{:else}<p class="small muted">
									표시할 초안이 없습니다. 새 자료를 올려 초안을 만들어 보세요.
								</p>{/each}<a class="text-link" href="/drafts">초안 검토하기 →</a>
						</section>
						<section class="panel">
							<h2>연결이 많은 문서</h2>
							{#each data.hubs as doc, i}<a class="rank-row" href={documentHref(doc.slug)}
									><span>{i + 1}</span><b>{doc.title}</b><small>{doc.links} 연결</small></a
								>{/each}
						</section>
					</aside>
				</div>
				<div class="community-grid">
					<section class="panel">
						<h2>주요 공지</h2>
						{#each data.announcements as item}<details class="announcement">
								<summary>{item.title}<time>{formatDate(item.created_at)}</time></summary>
								<p>{item.body}</p>
							</details>{:else}<p class="muted">등록된 공지가 없습니다.</p>{/each}
					</section>
					<section class="panel">
						<h2>최근 토론</h2>
						{#each data.discussions as item}<a
								class="discussion-link"
								href={`/discussion/${encodeURIComponent(item.slug)}`}
								><strong>{item.thread_title}</strong><small
									>{item.document_title} · {formatDate(item.created_at)}</small
								></a
							>{:else}<p class="muted">
								문서를 읽다가 궁금한 점이 생기면 토론을 시작해 보세요.
							</p>{/each}
					</section>
				</div>
			{:else}
				<div class="content-grid map-grid">
					<section class="panel map-panel" id="knowledge-map" aria-label="지식 지도 탐색">
						<h2>지식은 연결될수록 커집니다</h2>
						<p class="small muted">
							주변 항목을 누르면 그 문서를 중심으로 연결을 다시 보여 줍니다. 가운데 항목을 누르면
							문서가 열립니다.
						</p>
						<KnowledgeMap graph={data.graph} />
						<div class="map-legend">
							<span></span> 중심 문서 <span></span> 연결된 문서 <small>실제 위키 링크 기준</small>
						</div>
					</section>
					<aside class="stack">
						<section class="panel">
							<h2>연결이 가장 많은 문서</h2>
							{#each data.hubs as doc}<div class="hub-row">
									<a href={knowledgeMapHref(doc.slug)} title={`${doc.title} 중심으로 연결 보기`}
										>{doc.title}</a
									>
									<div class="hub-track">
										<span
											style={`width:${data.hubs[0].links ? (doc.links / data.hubs[0].links) * 100 : 0}%`}
										></span>
									</div>
									<small>{doc.links}</small>
								</div>{:else}<p class="muted">아직 연결된 문서가 없습니다.</p>{/each}
						</section>
						<section class="panel olive-panel">
							<h2>이어질 지식 {data.missing.length}곳</h2>
							<p class="small">
								다른 문서가 링크했지만 아직 내용이 없는 용어입니다. 한 문단이면 이어집니다.
							</p>
							<div class="chips">
								{#each data.missing.slice(0, 8) as doc}<a
										class="chip"
										href={`/edit/${encodeURIComponent(doc.slug)}`}>{doc.title} +</a
									>{:else}<span class="small">표시할 미작성 링크가 없습니다.</span>{/each}
							</div>
						</section>
					</aside>
				</div>
			{/if}
		</div>
	{/if}
</main>
