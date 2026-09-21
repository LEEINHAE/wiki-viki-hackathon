<script>
	import MetadataChanges from '$lib/components/MetadataChanges.svelte';
	import { canAccessRoute } from '$lib/auth-policy.js';
	let { data, form } = $props();
</script>

<svelte:head><title>{data.document.title} · 문서 역사 — 위키비키</title></svelte:head>
<div class="form-page">
	<section class="wiki-form">
		<header class="document-header">
			<h1>문서 역사: {data.document.title}</h1>
			<div class="document-meta">이 문서에 저장된 모든 버전을 확인할 수 있습니다.</div>
			{#if data.document.wv_merged_into}<p class="notice">
					다른 문서에 병합된 원본의 역사입니다. 운영 계정은 병합 전 전체 상태를 복원할 수 있습니다.
				</p>{/if}
		</header>
		<nav class="document-actions">
			<a href={`/wiki/${data.document.slug}`}>읽기</a><a href={`/edit/${data.document.slug}`}
				>편집</a
			><a href={`/discussion/${data.document.slug}`}>토론</a>
		</nav>
		{#if form?.message}<div class="notice warning">{form.message}</div>{/if}
		<form method="GET" class="search-filters">
			<label
				>이전 리비전 <input
					name="from"
					type="number"
					min="1"
					value={data.from || ''}
					placeholder="번호"
					required
				/></label
			><label
				>비교 리비전 <input
					name="to"
					type="number"
					min="1"
					value={data.selected || ''}
					placeholder="번호"
					required
				/></label
			><button class="secondary-button">두 버전 비교</button>
		</form>
		{#if data.rollback}<section class="notice">
				<h2>리비전 {data.rollback.id} 본문으로 되돌리기 전 비교</h2>
				<p>
					현재 본문에서 삭제되는 부분과 복구할 부분입니다. 제목·별칭은 유지됩니다. 되돌림도 새
					리비전으로 남깁니다.
				</p>
				<div class="diff-box">
					{#each data.rollback.changes as part}<span
							class:diff-add={part.added}
							class:diff-remove={part.removed}>{part.value}</span
						>{/each}
				</div>
				{#if data.canRollback && !data.document.deleted_at && !data.document.wv_merged_into}<form
						method="POST"
						action="?/rollback"
					>
						<input type="hidden" name="version" value={data.document.version} /><input
							type="hidden"
							name="revision"
							value={data.rollback.id}
						/>{#if !data.user}<label
								>익명 편집자 <input name="editor" value="Editor-01" required /></label
							>{/if}<button class="danger-button">차이를 확인하고 본문 되돌리기</button>
					</form>{/if}
				<h3>전체 상태를 복원할 때의 메타데이터 차이</h3>
				<MetadataChanges changes={data.rollback.metadata} />
				{#if !data.rollback.full}<p>
						이전 기록에는 전체 상태가 없어 본문만 되돌릴 수 있습니다. 기록이 없는 항목은 추정하지
						않습니다.
					</p>
				{:else if data.canRestoreState}<form method="POST" action="?/restoreState">
						<input type="hidden" name="version" value={data.document.version} /><input
							type="hidden"
							name="revision"
							value={data.rollback.id}
						/>
						<p>
							본문·제목·별칭·분류·태그·출처·읽기 권한·보관·삭제·병합 연결·담당자·검토 기록을 선택한
							버전으로 복원합니다. 이후 생긴 주소는 계속 연결되고 모든 리비전은 보존됩니다. 다른
							문서의 본문과 초안 게시 이력은 개별 기록으로 유지됩니다.
						</p>
						<label
							><input type="checkbox" name="reviewed" value="yes" required /> 위 차이와 읽기 권한, 공개될
							내용을 확인했습니다.</label
						>
						<button class="danger-button">전체 문서 상태 복원</button>
					</form>{:else}<p>전체 상태 복원은 운영 계정에서 실행할 수 있습니다.</p>{/if}
			</section>{/if}
		{#if data.selected}<h2>리비전 {data.from || '빈 본문'} → {data.selected} 변경 사항</h2>
			<div class="diff-box">
				{#each data.changes as part}<span
						class:diff-add={part.added}
						class:diff-remove={part.removed}>{part.value}</span
					>{/each}
			</div>
			<MetadataChanges changes={data.metadata} />{/if}
		<ul class="history-list">
			{#each data.revisions as revision}<li>
					<time>{new Date(revision.created_at).toLocaleString('ko-KR')}</time><b
						>{revision.editor_handle}</b
					><span>{revision.summary || '요약 없음'}</span><span
						><a href={`?diff=${revision.id}`}>차이 보기</a> ·
						<a href={`?restore=${revision.id}`}>되돌리기 전 비교</a> ·
						<a href={`/wiki/${encodeURIComponent(data.document.slug)}?revision=${revision.id}`}
							>리비전 {revision.id} 읽기</a
						></span
					>
					{#if revision.details?.type === 'ai_merge'}<details class="merge-history">
							<summary>AI 통합 · 상충 상세 {revision.details.conflicts.length}개</summary>
							<p>
								새 초안 우선 · 초안 {revision.details.draftId}: {revision.details.draftTitle} · 원문 {revision
									.details.sourceName || '미등록'}
							</p>
							<p>
								{revision.details.manuallyEdited
									? '검토자가 AI 통합 본문을 추가 수정했습니다.'
									: 'AI 통합 본문을 검토 후 적용했습니다.'}
							</p>
							{#each revision.details.conflicts as conflict}<h3>{conflict.topic}</h3>
								<p class="diff-remove">기존: {conflict.previous}</p>
								<p class="diff-add">새 초안: {conflict.incoming}</p>{/each}
						</details>{/if}
					{#if revision.details?.type === 'proposal'}<p>
							{#if canAccessRoute(data.user?.role, '/proposals/[slug]')}<a
									href={`/proposals/${encodeURIComponent(data.document.slug)}?open=${revision.details.proposalId}`}
									>승인한 수정 제안 #{revision.details.proposalId}</a
								>{:else}승인한 수정 제안 #{revision.details.proposalId}{/if}
							· {revision.details.manuallyEdited ? '검토자가 최종 표현을 수정함' : '제안 본문 적용'}
						</p>{/if}
					{#if revision.details?.type === 'document_merge'}<p>
							병합한 원본: <a
								href={`/wiki/${encodeURIComponent(revision.details.sourceSlug)}?revision=${revision.details.sourceRevisionId}`}
								>{revision.details.sourceTitle}의 당시 본문</a
							>
							·
							<a href={`?diff=${revision.details.targetPreviousRevisionId}`}>대상의 병합 전 버전</a>
						</p>{/if}
					{#if revision.details?.type === 'document_merge_source'}<p>
							<a
								href={`/wiki/${encodeURIComponent(revision.details.targetSlug)}?revision=${revision.details.targetRevisionId}`}
								>병합 결과 리비전</a
							>
						</p>{/if}
				</li>{/each}
		</ul>
		<nav class="pagination" aria-label="역사 페이지">
			{#if data.page > 1}<a href={`?page=${data.page - 1}`}>이전</a>{/if}<span
				>{data.page} / {Math.max(1, Math.ceil(data.total / 20))} 페이지</span
			>{#if data.page * 20 < data.total}<a href={`?page=${data.page + 1}`}>다음</a>{/if}
		</nav>
	</section>
</div>
