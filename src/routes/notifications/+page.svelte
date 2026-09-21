<script>
	import { canAccessRoute } from '$lib/auth-policy.js';
	let { data } = $props();
	const labels = {
		document_changed: '구독 문서 변경',
		review_requested: '문서 검토 요청',
		discussion_reply: '참여 토론 답글',
		proposal_review: '수정 제안 검토 요청',
		proposal_result: '수정 제안 결과'
	};
</script>

<svelte:head><title>내 알림 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>내 알림</h1>
	<p>구독한 문서 변경과 나에게 요청된 검토를 표시합니다. 현재 읽을 수 있는 문서만 표시합니다.</p>
	<div class="button-row">
		<a href="/notifications">전체</a><a href="/notifications?unread=1">읽지 않음</a><a
			href="/library">구독 관리</a
		>
	</div>
	<section class="card">
		{#each data.rows as row}<article class="search-result">
				<span class="tag">{row.read_at ? '읽음' : '새 알림'}</span>
				<h2>
					<a
						href={row.proposal_id && canAccessRoute(data.user?.role, '/proposals/[slug]')
							? `/proposals/${encodeURIComponent(row.slug)}?open=${row.proposal_id}`
							: row.discussion_id
								? `/discussion/${encodeURIComponent(row.slug)}?thread=${row.discussion_id}`
								: `/wiki/${encodeURIComponent(row.slug)}${row.revision_id ? `?revision=${row.revision_id}` : ''}`}
						>{row.title}</a
					>
				</h2>
				<p>
					{labels[row.kind] || '문서 알림'} · {row.actor || '운영 기록'} · {new Date(
						row.created_at
					).toLocaleString('ko-KR')}
				</p>
				{#if !row.read_at}<form method="POST" action="?/read">
						<input type="hidden" name="id" value={row.id} /><button class="secondary-button"
							>읽음 표시</button
						>
					</form>{/if}
			</article>{:else}<p>현재 표시할 알림이 없습니다.</p>{/each}
		<nav class="pagination" aria-label="알림 페이지">
			{#if data.page > 1}<a href={`?unread=${data.unread ? '1' : '0'}&page=${data.page - 1}`}
					>이전</a
				>{/if}<span>{data.page}페이지</span>{#if data.page * 30 < data.total}<a
					href={`?unread=${data.unread ? '1' : '0'}&page=${data.page + 1}`}>다음</a
				>{/if}
		</nav>
	</section>
</main>
