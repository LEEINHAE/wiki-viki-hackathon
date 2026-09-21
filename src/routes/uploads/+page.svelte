<script>
	import { relativeTime } from '$lib/wiki-utils.js';
	let { data } = $props();
	const labels = {
		received: '수신',
		extracting: '텍스트 추출',
		inspecting: '콘텐츠 검사',
		generating: '초안 생성',
		saving: '저장',
		completed: '완료',
		failed: '실패',
		interrupted: '중단'
	};
</script>

<svelte:head><title>업로드 작업 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>업로드 작업 다시 찾기</h1>
	<p>
		{data.user ? '현재 계정' : '현재 브라우저'}에서 요청한 최근 30개 작업입니다. 작업 기록은 실행
		상태를 알려 줍니다. 페이지를 닫아도 처리가 계속될 수 있지만 백그라운드 실행을 보장하지 않습니다.
	</p>
	<div class="button-row">
		<a class="primary-button" href="/wikify">파일 전환</a><a
			class="secondary-button"
			href={data.selected ? `/uploads?open=${data.selected.id}` : '/uploads'}
			data-sveltekit-reload>상태 새로고침</a
		><a href="/drafts">초안 목록</a>
	</div>
	{#if data.problem}<p class="notice warning" role="alert">{data.problem}</p>{/if}
	{#if data.selected}<section class="card">
			<h2>작업 #{data.selected.id} · {data.selected.file_name}</h2>
			<p>{labels[data.selected.state]} · {data.selected.stage} · 시도 {data.selected.attempts}회</p>
			{#if data.selected.message}<p class="notice warning">
					{data.selected.message}
				</p>{/if}{#if data.selected.expired}<p class="notice warning">
					6분 이상 상태가 갱신되지 않았습니다. 서버 실행이 중단되었을 수 있습니다. 같은 파일을 다시
					선택하고 재시도할 수 있습니다.
				</p>{/if}
			<ul>
				{#each data.drafts as draft}<li>
						<a href={`/drafts?open=${draft.id}`}>{draft.title}</a> · {draft.status === 'published'
							? '게시 완료'
							: draft.status === 'blocked'
								? '게시 차단'
								: '검토 대기'}{#if draft.merged?.slug}
							· <a href={`/wiki/${encodeURIComponent(draft.merged.slug)}`}>통합 문서</a>{/if}
					</li>{:else}<li>
						아직 저장된 초안이 없습니다. 실패·중단 작업은 같은 파일을 다시 올려 재시도하세요.
					</li>{/each}
			</ul>
		</section>{/if}
	<section class="card">
		{#each data.jobs as job}<article class="search-result">
				<a href={`?open=${job.id}`}>#{job.id} · {job.file_name}</a>
				<p>
					{labels[job.state]} · {job.stage}{job.expired ? ' · 상태 갱신 지연' : ''} · {relativeTime(
						job.updated_at
					)}
				</p>
			</article>{:else}<p>
				이 브라우저에서 찾을 수 있는 업로드가 없습니다. 다른 브라우저에서 만든 초안은 초안 목록에서
				확인할 수 있습니다.
			</p>{/each}
	</section>
</main>
