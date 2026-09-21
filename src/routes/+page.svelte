<script>
	import { getContext } from 'svelte';
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import KnowledgeMap from '$lib/components/KnowledgeMap.svelte';
	import { docUrl, relativeTime, slugify } from '$lib/wiki-utils.js';
	let { data } = $props();
	const openWikifier = getContext('openWikifier');
	const layouts = [
		{ id: 'search', name: 'A · 검색 우선', note: '찾는 일에 집중. 아래는 지표와 기여 유도만.' },
		{
			id: 'activity',
			name: 'B · 활동 대시보드',
			note: '누가 무엇을 고쳤는지 먼저. 함께 쌓아가는 지식.'
		},
		{ id: 'map', name: 'C · 지식 지도', note: '문서 간 연결을 따라 새로운 지식을 발견하세요.' }
	];
	const activeLayout = $derived(page.state.homeLayout || data.layout);
	function selectLayout(id) {
		pushState(`/?layout=${id}`, { homeLayout: id });
	}
	function tabKey(event, index) {
		let next = index;
		if (event.key === 'ArrowRight') next = (index + 1) % layouts.length;
		else if (event.key === 'ArrowLeft') next = (index + layouts.length - 1) % layouts.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = layouts.length - 1;
		else return;
		event.preventDefault();
		selectLayout(layouts[next].id);
		event.currentTarget.parentElement.children[next].focus();
	}
	const answer = $derived(data.results.find((doc) => !doc.isDraft));
</script>

<svelte:head
	><title>{data.q ? `「${data.q}」 검색 결과` : '모르는 것은 5초 안에'} — 위키비키</title><meta
		name="description"
		content="모르는 것은 5초 안에, 아는 것은 5분 안에. 함께 만드는 사내 자율진화형 지식 위키."
	/></svelte:head
>
<main class="page-shell" class:home-page={!data.q}>
	{#if !data.databaseReady}<div class="notice warning">
			문서를 불러오지 못했습니다. 잠시 후 <a
				href={data.q ? `/?q=${encodeURIComponent(data.q)}` : '/'}
				data-sveltekit-reload>다시 시도</a
			>해 주세요.
		</div>{/if}
	{#if !data.q}
		<section class="hero">
			<span class="eyebrow"><i></i>사내 자율진화형 지식 위키</span>
			<h1>모르는 것은 5초 안에,<br />아는 것은 5분 안에.</h1>
			<p>
				검색창 하나로 시작합니다. 결과는 문서 목록이 아니라 바로 읽히는 설명입니다. 필요한 문서가
				없다면 기존 사내 문서를 올려 초안부터 시작하세요.
			</p>
			<SearchBox onwikify={openWikifier} />
			<div class="trending-tags">
				<span>요즘 많이 찾는 용어</span>{#each data.trending as doc}<a
						class="tag tag-outline"
						href={docUrl(doc)}>{doc.title}</a
					>{:else}<span>첫 문서를 검색하거나 만들어 보세요.</span>{/each}
			</div>
		</section>
		<div class="layout-switcher">
			<span class="overline">홈 아래 영역 · IA 시안</span>
			<div class="segmented" role="tablist" aria-label="홈 화면 구성">
				{#each layouts as layout, index}<button
						role="tab"
						aria-selected={activeLayout === layout.id}
						aria-controls="home-panel"
						class:active={activeLayout === layout.id}
						tabindex={activeLayout === layout.id ? 0 : -1}
						onkeydown={(event) => tabKey(event, index)}
						onclick={() => selectLayout(layout.id)}>{layout.name}</button
					>{/each}
			</div>
			<span class="layout-note">{layouts.find((layout) => layout.id === activeLayout)?.note}</span>
		</div>
		<div
			id="home-panel"
			role="tabpanel"
			tabindex="0"
			aria-label={layouts.find((layout) => layout.id === activeLayout)?.name}
		>
			{#if activeLayout === 'search'}
				<div class="stats-grid">
					{#each [{ value: data.stats.documents, label: '게시된 문서', green: false }, { value: data.stats.edits, label: '이번 주 편집', green: false }, { value: data.stats.links, label: '문서 간 연결', green: true }, { value: data.stats.drafts, label: '검토 대기 초안', green: true }] as stat}<div
							class="card stat"
						>
							<strong class:green={stat.green}>{stat.value.toLocaleString('ko-KR')}</strong><span
								>{stat.label}</span
							>
						</div>{/each}
				</div>
				<section class="contribution-panel">
					<div>
						<h2>백지에서<br />시작하지 않습니다</h2>
						<p>
							위키가 자리 잡지 못하는 이유는 관심이 없어서가 아니라, 아무도 첫 문서를 쓰지 않기
							때문입니다.
						</p>
						<button class="primary-button" onclick={openWikifier}>AI 위키파이어 열기</button>
					</div>
					<div class="steps-cards">
						{#each [{ title: '기존 문서 올리기', text: '회의록, 설비 매뉴얼, 약어집 PDF' }, { title: 'AI가 초안 작성', text: '용어를 뽑아 문서로 나누고 서로 링크' }, { title: '고쳐서 게시', text: '쓰는 일보다 고치는 일이 훨씬 가볍습니다' }] as step, index}<div
							>
								<b class:orange={index === 2}>{index + 1}</b><strong>{step.title}</strong>
								<p>{step.text}</p>
							</div>{/each}
					</div>
				</section>
			{:else if activeLayout === 'activity'}
				<div class="dashboard-grid">
					<section class="card">
						<div class="section-title">
							<h2>최근 변경</h2>
							<a href="/recent">모두 보기 →</a>
						</div>
						{#each data.changes.slice(0, 6) as change}<div class="activity-row">
								<a href={docUrl(change)}>{change.title}</a><span
									>{change.summary || '문서 업데이트'}</span
								><b>{change.editor_handle}</b><time>{relativeTime(change.updated_at)}</time>
							</div>{:else}<p class="muted">아직 변경 기록이 없습니다.</p>{/each}
					</section>
					<aside class="stack">
						<section class="card peach">
							<h3>검토를 기다리는 초안</h3>
							<p class="muted">AI가 만든 초안 {data.stats.drafts}건. 아는 내용을 더해 주세요.</p>
							{#each data.drafts as draft}<a class="draft-teaser" href={docUrl(draft)}
									><b>{draft.title}</b><small>{draft.source_name}</small></a
								>{:else}<p>새 자료를 올려 첫 초안을 만들어 보세요.</p>
								<button class="secondary-button" onclick={openWikifier}>초안 만들기</button>{/each}
						</section>
						<section class="card">
							<h3>요즘 많이 찾는 용어</h3>
							{#each data.trending as doc, index}<div class="ranking-row">
									<span>{index + 1}</span><a href={docUrl(doc)}>{doc.title}</a><small
										>{Number(doc.views || 0).toLocaleString('ko-KR')}</small
									>
								</div>{/each}
						</section>
					</aside>
				</div>
			{:else}
				<div class="dashboard-grid">
					<section class="card">
						<h2>가장 많이 이어진 용어</h2>
						<p class="muted">
							문서가 서로 링크될수록 위키는 사내 온톨로지에 가까워집니다. 노드를 눌러 따라가 보세요.
						</p>
						<KnowledgeMap graph={data.graph} />
					</section>
					<aside class="stack">
						<section class="card">
							<h3>연결이 가장 많은 문서</h3>
							{#each data.hubs.slice(0, 5) as doc}<div class="hub-row">
									<a href={docUrl(doc)}>{doc.title}</a>
									<div class="bar-track">
										<i
											style={`width:${(doc.backlinks.length / Math.max(1, data.hubs[0]?.backlinks.length)) * 100}%`}
										></i>
									</div>
									<span>{doc.backlinks.length}</span>
								</div>{/each}
						</section>
						<section class="card olive">
							<h3>끊어진 연결 {data.missing.length}곳</h3>
							<p>다른 문서가 링크했지만 아직 내용이 없는 용어입니다. 한 문단이면 이어집니다.</p>
							<div class="tag-list">
								{#each data.missing.slice(0, 8) as doc}<a
										class="tag tag-outline"
										href={`/edit/${encodeURIComponent(doc.slug)}`}>{doc.title}</a
									>{:else}<span class="muted">모든 문서가 연결되어 있습니다.</span>{/each}
							</div>
							{#if data.missing.length > 8}<details style="margin-top:14px">
									<summary>나머지 {data.missing.length - 8}개 보기</summary>
									<div class="tag-list" style="margin-top:12px">
										{#each data.missing.slice(8) as doc}<a
												class="tag tag-outline"
												href={`/edit/${encodeURIComponent(doc.slug)}`}>{doc.title}</a
											>{/each}
									</div>
								</details>{/if}
						</section>
					</aside>
				</div>
			{/if}
		</div>
	{:else}
		<header class="search-heading">
			<h1>「{data.q}」 검색 결과</h1>
			<span>문서 {data.results.length}건 · {data.elapsed || '0.00'}초</span>
		</header>
		<div class="search-grid">
			<div class="stack">
				{#if answer}<section class="answer-card">
						<span class="overline">✧ 바로 읽히는 설명</span>
						<h2>{answer.title}</h2>
						<p>{answer.description}</p>
						<div class="tag-list">
							{#each answer.related.slice(0, 4) as related}<a class="tag" href={docUrl(related)}
									>{related.title}</a
								>{/each}
						</div>
						<div class="answer-footer">
							<a class="primary-button" href={docUrl(answer)}>문서 전체 보기</a><span
								>최근 수정 {relativeTime(answer.updated_at)} · {answer.editor_handle} · 조회 {Number(
									answer.views || 0
								).toLocaleString('ko-KR')}</span
							>
						</div>
					</section>{/if}
				<section class="card results-card">
					{#each data.results as doc}<article class="search-result">
							<div>
								<a href={docUrl(doc)}>{doc.title}</a>{#if doc.isDraft}<span class="tag tag-green"
										>AI 초안</span
									>{/if}<small>{doc.field}</small>
							</div>
							<p>{doc.description}</p>
							<small
								>{doc.editor_handle} · {relativeTime(doc.updated_at)} · {doc.isDraft
									? '검토 대기'
									: `역링크 ${doc.backlinks.length}`}</small
							>
						</article>{:else}<div class="empty-state">
							<h2>아직 이 지식은 비어 있습니다</h2>
							<p>다른 표현으로 검색하거나, 첫 문서를 만들어 주세요.</p>
						</div>{/each}
					<div class="search-create">
						<span>찾는 내용이 없나요?</span><button class="secondary-button" onclick={openWikifier}
							>기존 자료 올려 초안 만들기</button
						><a
							href={`/edit/${encodeURIComponent(slugify(data.q) || '새-문서')}?title=${encodeURIComponent(data.q)}`}
							>빈 문서로 새로 쓰기</a
						>
					</div>
				</section>
			</div>
			<aside class="stack">
				<section class="card">
					<h3>분야로 좁히기</h3>
					<div class="tag-list">
						<a class="tag" class:active={!data.field} href={`/?q=${encodeURIComponent(data.q)}`}
							>전체</a
						>{#each data.facets as facet}<a
								class="tag"
								class:active={data.field === facet.name}
								href={`/?q=${encodeURIComponent(data.q)}&field=${encodeURIComponent(facet.name)}`}
								>{facet.name} {facet.count}</a
							>{/each}
					</div>
				</section>
				<section class="card">
					<h3>이어서 읽어 볼 문서</h3>
					{#each data.trending.filter((doc) => doc.slug !== answer?.slug).slice(0, 4) as doc}<a
							class="list-link"
							href={docUrl(doc)}>{doc.title}<span>↗</span></a
						>{/each}
				</section>
			</aside>
		</div>
	{/if}
</main>
