<script>
	import RecentSidebar from '$lib/components/RecentSidebar.svelte';
	let { data } = $props();
</script>

<svelte:head>
	<title>Wiki Viki — 대문</title>
	<meta name="description" content="함께 만드는 Wiki Viki 사내 지식 저장소" />
</svelte:head>
<div class="site-grid">
	<main class="wiki-paper main-page">
		<header class="document-header home-header">
			<div class="home-wordmark">
				<span>W</span>
				<div>
					<h1>Wiki Viki</h1>
					<p>누구나 함께 개선하는 사내 위키입니다.</p>
				</div>
			</div>
			<form class="hero-search" method="GET">
				<input name="q" value={data.q} aria-label="문서 검색" placeholder="Wiki Viki 검색" />
				<button>검색</button>
			</form>
		</header>
		{#if !data.databaseReady}<div class="notice warning">
				<strong>초기 설정이 필요합니다.</strong> PostgreSQL을 연결하고
				<code>bun run migrate</code>를 실행하세요. 화면은 사용할 수 있지만 실제 콘텐츠는 아직 불러올
				수 없습니다.
			</div>{/if}
		{#if data.q}<section class="main-section">
				<h2>“{data.q}” 검색 결과</h2>
				<ul class="document-list">
					{#each data.results as doc}<li>
							<a href={`/wiki/${doc.slug}`}>{doc.title}</a>
							<time>{new Date(doc.updated_at).toLocaleString('ko-KR')}</time>
						</li>{:else}<li>
							일치하는 문서가 없습니다.
							<a class="missing" href={`/edit/${encodeURIComponent(data.q)}`}>이 문서 만들기</a>
						</li>{/each}
				</ul>
			</section>{/if}
		<section class="welcome-panel">
			<h2>Wiki Viki에 오신 것을 환영합니다</h2>
			<p>
				Wiki Viki는 정책, 시스템, 용어와 업무 방식을 함께 기록하는 지식 저장소입니다. 먼저 검색하고,
				필요한 내용이 없다면 새 문서를 만들어 주세요.
			</p>
			<div class="portal-links">
				<a href="/wiki/wiki-viki:기본-정책"><b>소개</b><span>목적과 기본 원칙</span></a><a
					href="/wiki/wiki-viki:편집-지침"><b>편집 정책</b><span>문서 작성 기준</span></a
				><a href="/wikify"><b>AI 위키 변환</b><span>DOCX·PDF 문서 변환</span></a><a href="/drafts"
					><b>초안 검토</b><span>게시 전 초안 확인</span></a
				><a href="/wiki/wiki-viki:도움말"><b>도움말</b><span>문법과 참여 안내</span></a>
			</div>
		</section>
		<div class="main-columns">
			<section class="main-section">
				<h2>주요 공지</h2>
				<ul class="bullet-list">
					{#each data.announcements as item}<li>
							<span class="tag">공지</span><b>{item.title}</b><time
								>{new Date(item.created_at).toLocaleDateString('ko-KR')}</time
							>
						</li>{:else}<li>등록된 공지가 없습니다.</li>{/each}
				</ul>
			</section>
			<section class="main-section">
				<h2>최근 토론</h2>
				<ul class="bullet-list">
					{#each data.discussions as item}<li>
							<a href={`/discussion/${item.slug}`}>{item.thread_title}</a><small
								>{item.document_title} 문서</small
							>
						</li>{:else}<li>아직 토론이 없습니다.</li>{/each}
				</ul>
			</section>
		</div>
	</main>
	<RecentSidebar changes={data.changes} />
</div>
