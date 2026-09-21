<script>
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { invalidateAll } from '$app/navigation';
	import { documentHref } from '$lib/knowledge.js';
	let { data } = $props();
	let checking = $state(false),
		message = $state(''),
		problem = $state('');
	async function reconnect(event) {
		event.preventDefault();
		if (checking) return;
		checking = true;
		message = '';
		problem = '';
		try {
			await invalidateAll();
			if (!data.databaseError) message = '최신 문서와 별칭으로 전체 연결을 다시 계산했습니다.';
		} catch {
			problem = '연결을 검사하지 못했습니다. 잠시 후 다시 시도해 주세요.';
		} finally {
			checking = false;
		}
	}
</script>

<svelte:head><title>문서 자동 연결 — 위키비키</title></svelte:head>
<main class="page-shell link-page work-page">
	<header class="page-intro document-header">
		<span class="eyebrow">문서 연결</span>
		<h1>문서 자동 연결</h1>
		<p>
			본문에 등장하는 문서 제목과 별칭을 찾아 자동으로 연결합니다. 링크마다 승인할 필요 없이 관련
			문서와 역링크에서도 확인할 수 있습니다.
		</p>
	</header>
	<form method="GET" action="/links" onsubmit={reconnect} aria-busy={checking}>
		<button class="primary-button" disabled={checking}
			>{checking ? '전체 연결 검사 중…' : '전체 검사·자동 재연결'}</button
		>
		<p class="small muted">
			게시·수정·별칭 변경·삭제·복구는 페이지를 다시 열 때 반영됩니다. 원문과 편집 이력은 그대로
			유지합니다.
		</p>
	</form>
	{#if checking}<StatusNotice tone="pending" role="status">
			현재 게시 문서 전체의 연결을 확인하고 있습니다.
		</StatusNotice>{/if}
	{#if message}<StatusNotice tone="success" role="status">{message}</StatusNotice>{/if}
	{#if problem || data.databaseError}
		<StatusNotice tone="error" role="alert">
			{problem || '문서 연결을 불러오지 못했습니다. 다시 검사해 주세요.'}
		</StatusNotice>
	{:else if data.report}
		{@const report = data.report}
		<dl class="link-summary" aria-label="전체 연결 검사 결과">
			<div>
				<dt>검사한 문서</dt>
				<dd>{report.documents}</dd>
			</div>
			<div>
				<dt>전체 연결</dt>
				<dd>{report.total}</dd>
			</div>
			<div>
				<dt>자동 연결</dt>
				<dd>{report.automatic}</dd>
			</div>
			<div>
				<dt>연결 없는 문서</dt>
				<dd>{report.isolated}</dd>
			</div>
		</dl>
		<p class="small muted">
			검사 시각: <time datetime={report.checkedAt}
				>{new Date(report.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</time
			>. 문서별로 같은 대상에 대한 반복 링크는 한 번만 셉니다.
		</p>
		{#if report.unresolved}<StatusNotice tone="info" role={null}>
				아직 게시되지 않은 수동 링크가 {report.unresolved}개 있습니다. 대상 문서가 게시되면 자동으로
				연결됩니다.
			</StatusNotice>{/if}
		{#if report.ambiguous.length}<details class="notice warning">
				<summary>여러 문서가 사용하는 이름 {report.ambiguous.length}개</summary>
				<p>
					자동으로 대상을 정할 수 없는 이름입니다. 별칭을 구분하거나 직접 위키 링크를 지정할 수
					있습니다.
				</p>
				<p>{report.ambiguous.join(' · ')}</p>
			</details>{/if}
		{#if report.rows.length}
			<ol class="connection-list" aria-label="문서별 연결">
				{#each report.rows as row}
					<li>
						<h2><a href={documentHref(row.slug)}>{row.title}</a></h2>
						<p class="small muted">
							나가는 연결 {row.connections.length}개 · 이 문서를 가리키는 문서 {row.incoming}개
						</p>
						<ul>
							{#each row.connections as connection}<li>
									<a href={documentHref(connection.target)}>{connection.title}</a><span class="tag"
										>{connection.automatic ? '자동 연결' : '작성한 링크'}</span
									><span class="small muted">본문: {connection.label}</span>
								</li>{:else}<li class="muted">
									본문에서 연결할 문서 이름을 찾지 못했습니다.
								</li>{/each}
						</ul>
						{#if row.missing.length}<p class="small">
								미작성 링크: {#each row.missing as missing, i}{i ? ' · ' : ''}<a
										href={documentHref(missing.slug)}>{missing.title}</a
									>{/each}
							</p>{/if}
					</li>
				{/each}
			</ol>
			{#if report.pages > 1}<nav class="pagination" aria-label="연결 목록 페이지">
					{#if report.page > 1}<a class="secondary-button" href={`/links?page=${report.page - 1}`}
							>← 이전</a
						>{/if}<span>{report.page} / {report.pages} 페이지</span
					>{#if report.page < report.pages}<a
							class="secondary-button"
							href={`/links?page=${report.page + 1}`}>다음 →</a
						>{/if}
				</nav>{/if}
		{:else}<EmptyState framed title="아직 게시된 문서가 없습니다.">
				<p>문서를 게시하면 본문의 제목·별칭을 찾아 서로 연결합니다.</p>
				{#snippet actions()}<a class="secondary-button" href="/drafts">초안 검토하기 →</a>{/snippet}
			</EmptyState>{/if}
	{/if}
	<p class="small muted">
		자동 연결은 제목·등록 별칭과 일치하는 표현을 사용합니다. 코드·기존 링크·자기 문서는 자동
		연결에서 제외하며, 같은 대상은 본문의 첫 일치에 연결합니다. 내용만 비슷한 문서를 추측해서
		연결하지 않습니다.
	</p>
</main>

<style>
	.link-page {
		max-width: var(--work-width);
	}
	.page-intro p {
		max-width: 720px;
	}
	form {
		margin: 24px 0;
	}
	.link-summary {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 12px;
	}
	.link-summary > div {
		border: 1px solid var(--line);
		padding: var(--inset-padding);
		border-radius: var(--inset-radius);
		background: var(--paper);
	}
	dt {
		color: var(--secondary);
	}
	dd {
		margin: 4px 0 0;
		font-size: 28px;
		font-weight: 700;
	}
	.connection-list {
		list-style: none;
		padding: 0;
		border-top: 1px solid var(--line);
	}
	.connection-list > li {
		padding: 22px 0;
		border-bottom: 1px solid var(--line);
		overflow-wrap: anywhere;
	}
	.connection-list ul {
		padding-left: 20px;
	}
	.connection-list ul li {
		padding: 4px 0;
	}
	.tag {
		margin: 0 8px;
	}
	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		margin: 24px 0;
	}
	@media (max-width: 600px) {
		.link-summary {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
