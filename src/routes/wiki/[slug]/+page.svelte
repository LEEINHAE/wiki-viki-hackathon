<script>
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Toc from '$lib/components/Toc.svelte';
	import DocumentConnections from '$lib/components/DocumentConnections.svelte';
	import { documentHref } from '$lib/knowledge.js';
	let { data } = $props();
	let body = $state();
	let mobileToc = $state();
	let desktopToc = $state();
	let ready = $state(false);
	let activeId = $state('');
	const currentSection = $derived(data.toc?.find((item) => item.id === activeId));

	function focusToc(event) {
		if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
		const target =
			desktopToc?.querySelector('a[aria-current="location"]') || desktopToc?.querySelector('a');
		if (target) {
			event.preventDefault();
			target.focus();
		}
	}
	function selectSection(event, item) {
		if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
		const target = document.getElementById(item.id);
		if (!target || !body?.contains(target)) return;
		if (mobileToc) mobileToc.open = false;
		activeId = item.id;
		target.tabIndex = -1;
		target.focus({ preventScroll: true });
	}
	function closeToc(event) {
		if (event.key === 'Escape' && mobileToc?.open && mobileToc.contains(event.target)) {
			event.preventDefault();
			mobileToc.open = false;
			mobileToc.querySelector('summary').focus();
		}
	}
	$effect(() => {
		const items = data.toc;
		const content = body;
		if (!content || !items?.length) {
			activeId = '';
			return;
		}
		ready = true;
		const mobile = mobileToc;
		const desktop = desktopToc;
		if (mobile) mobile.open = false;
		const headings = items.map((item) => document.getElementById(item.id)).filter(Boolean);
		if (!headings.length) return;
		const header = document.querySelector('.topbar');
		const media = matchMedia('(max-width: 800px)');
		let frame = 0;
		let initial = true;
		let focused;
		function update() {
			frame = 0;
			// Native fragment navigation precedes hydration. Only move a visible
			// fragment target if the enhanced mobile bar now covers it; preserve
			// restored reading positions elsewhere in the document.
			if (initial) {
				initial = false;
				let target;
				try {
					target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
				} catch {
					// An invalid URL fragment must not prevent reading the document.
				}
				if (!content.contains(target)) target = null;
				const rect = target?.getBoundingClientRect();
				const covered = Math.max(
					header?.getBoundingClientRect().bottom || 0,
					media.matches ? mobile?.querySelector('summary').getBoundingClientRect().bottom || 0 : 0
				);
				if (rect && rect.top >= 0 && rect.top < covered)
					target.scrollIntoView({ block: 'start', behavior: 'instant' });
			}
			const anchorOffset =
				parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) +
				parseFloat(getComputedStyle(headings[0]).scrollMarginTop);
			const edge =
				Math.max(
					anchorOffset,
					(header?.getBoundingClientRect().bottom || 0) +
						(media.matches
							? (mobile?.querySelector('summary').getBoundingClientRect().height || 0) + 8
							: 0)
				) + 2;
			let low = 0,
				high = headings.length;
			while (low < high) {
				const mid = Math.floor((low + high) / 2);
				if (headings[mid].getBoundingClientRect().top <= edge) low = mid + 1;
				else high = mid;
			}
			const selected = headings[Math.max(0, low - 1)];
			if (!selected) return;
			activeId = selected.id;
			// Keep the selected entry inside the sidebar without scrolling the document.
			if (!media.matches && desktop) {
				const link = [...desktop.querySelectorAll('a')].find((a) => a.hash === '#' + selected.id);
				const aside = desktop.parentElement;
				if (link) {
					const rect = link.getBoundingClientRect(),
						bounds = aside.getBoundingClientRect();
					if (rect.bottom > bounds.bottom) aside.scrollTop += rect.bottom - bounds.bottom + 8;
					else if (rect.top < bounds.top) aside.scrollTop -= bounds.top - rect.top + 8;
				}
			}
		}
		function schedule() {
			if (!frame) frame = requestAnimationFrame(update);
		}
		function rememberFocus(event) {
			focused =
				mobile?.contains(event.target) || desktop?.contains(event.target) ? event.target : null;
			dismissToc(event);
		}
		function dismissToc(event) {
			if (mobile?.open && !mobile.contains(event.target)) mobile.open = false;
		}
		function resizeToc() {
			const target = document.activeElement === document.body ? focused : document.activeElement;
			if (media.matches && desktop?.contains(target)) mobile?.querySelector('summary').focus();
			else if (!media.matches && mobile?.contains(target)) {
				const href = target.getAttribute('href') || '#' + activeId;
				const links = [...desktop.querySelectorAll('a')];
				(links.find((link) => link.getAttribute('href') === href) || links[0])?.focus();
			}
			if (mobile) mobile.open = false;
			schedule();
		}
		const observer = new ResizeObserver(schedule);
		observer.observe(content);
		if (header) observer.observe(header);
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		window.addEventListener('hashchange', schedule);
		document.addEventListener('focusin', rememberFocus);
		document.addEventListener('pointerdown', dismissToc);
		media.addEventListener('change', resizeToc);
		schedule();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			window.removeEventListener('hashchange', schedule);
			document.removeEventListener('focusin', rememberFocus);
			document.removeEventListener('pointerdown', dismissToc);
			media.removeEventListener('change', resizeToc);
		};
	});
	const modifiedDate = new Intl.DateTimeFormat('ko-KR', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'Asia/Seoul'
	});
</script>

<svelte:window onkeydown={closeToc} />
<svelte:head>
	<title
		>{data.missing
			? data.trashed
				? '휴지통에 있는 문서'
				: data.pendingDraft?.title || '아직 없는 문서'
			: data.document.title} — 위키비키</title
	>
</svelte:head>
<main class="page-shell article-page" class:reader-enhanced={ready} id="article-top">
	{#if data.missing}<EmptyState
			framed
			heading="h1"
			title={data.pendingDraft?.title || decodeURIComponent(data.slug).replaceAll('-', ' ')}
			label={data.trashed
				? '보관된 문서'
				: data.pendingDraft
					? '검토 중인 지식'
					: '아직 기록되지 않은 지식'}
		>
			{#if data.trashed}
				<p>이 문서는 휴지통에 있습니다. 원래 문서와 이력·별칭·토론을 보관하고 있습니다.</p>
			{:else if data.pendingDraft}
				<p>
					이 문서는 아직 게시되지 않았지만 검토 중인 초안이 있습니다. 내용을 확인하고 다듬어 주세요.
				</p>
			{:else}
				<p>이 문서는 아직 작성되지 않았습니다. 아는 것을 한 문단으로 남겨 보세요.</p>
			{/if}
			{#snippet actions()}
				{#if data.trashed}
					<a class="primary-button" href={'/trash?open=' + data.trashId}>휴지통에서 확인</a>
				{:else if data.pendingDraft}
					<a class="primary-button" href={`/drafts?open=${data.pendingDraft.id}`}>초안 열어보기 →</a
					>
				{:else}
					<a class="primary-button" href={`/edit/${encodeURIComponent(data.slug)}`}
						>첫 문장 쓰기 →</a
					>
				{/if}
				<a class="secondary-button" href="/">홈으로</a>
			{/snippet}
		</EmptyState>
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
				{#if data.toc.length}<div id="document-toc">
						<a class="text-link article-toc-jump" href="#desktop-document-toc" onclick={focusToc}
							>목차로 이동</a
						>
					</div>
					<details class="article-toc article-mobile-toc" bind:this={mobileToc}>
						<summary
							><strong>목차</strong><span
								>{currentSection
									? `${currentSection.number}. ${currentSection.title}`
									: '문단으로 이동'}</span
							></summary
						>
						<div class="toc-mobile-panel">
							<a
								class="text-link toc-return"
								href={`#${currentSection?.id || data.toc[0].id}`}
								onclick={(event) => selectSection(event, currentSection || data.toc[0])}
								>본문으로 돌아가기</a
							>
							<Toc items={data.toc} {activeId} onselect={selectSection} showTitle={false} />
						</div>
					</details>{/if}
				<div class="wiki-content" bind:this={body}>{@html data.html}</div>
				<div class="contribute-banner">
					<div>
						<h3>함께 다듬는 지식</h3>
						<p>
							{data.contributors}명의 편집자가 함께 만든 문서입니다. 더 나은 설명을 보태 주세요.
						</p>
					</div>
					<a class="secondary-button" href={`/edit/${encodeURIComponent(data.document.slug)}`}
						>문서 편집</a
					>
				</div>
				<section class="backlinks" aria-labelledby="backlinks-title">
					<h2 id="backlinks-title">
						이 문서를 가리키는 문서 <span class="tag">{data.backlinks.length}</span>
					</h2>
					{#if data.backlinks.length}
						<p class="small muted">아래 문서의 본문에서 이 문서로 연결됩니다.</p>
						<DocumentConnections items={data.backlinks} incoming />
					{:else}<p class="muted small">아직 이 문서를 가리키는 문서가 없습니다.</p>{/if}
				</section>
				<a class="article-back-top" href="#article-top">맨 위로 ↑</a>
			</article>
			<aside class="article-aside">
				{#if data.toc.length}<section
						class="article-side-section article-side-toc"
						id="desktop-document-toc"
						tabindex="-1"
						bind:this={desktopToc}
					>
						<Toc items={data.toc} {activeId} onselect={selectSection} collapsible={false} />
					</section>{/if}
				<section class="article-side-section" aria-labelledby="related-title">
					<h2 id="related-title">관련 문서 <span class="tag">{data.related.length}</span></h2>
					{#if data.related.length}
						<p class="small muted">이 문서의 본문에서 연결한 문서입니다.</p>
						<DocumentConnections items={data.related} />
					{:else}<p class="muted small">
							본문에 다른 문서의 제목이나 별칭이 등장하면 자동으로 연결합니다.
						</p>{/if}
					<a href="/links">전체 연결 검사 →</a>
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
							<dt>이 문서로 연결</dt>
							<dd>{data.backlinks.length}개</dd>
						</div>
						<div>
							<dt>이 문서에서 연결</dt>
							<dd>{data.related.length}개</dd>
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
