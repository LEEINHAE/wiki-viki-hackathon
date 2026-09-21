<script>
	import ActorIdentity from '$lib/components/ActorIdentity.svelte';
	import { enhance } from '$app/forms';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import FormRecovery from '$lib/components/FormRecovery.svelte';
	import { enhanceSave } from '$lib/enhance-save.js';
	import DraftMerge from '$lib/components/DraftMerge.svelte';
	import { getContext } from 'svelte';
	import Toc from '$lib/components/Toc.svelte';
	import { fields, relativeTime } from '$lib/wiki-utils.js';
	import { inspectionLocations } from '$lib/content-policy.js';
	let { data, form } = $props();
	let editForm = $state();
	let content = $state('');
	$effect(() => {
		content = (form?.editing ? form.content : null) ?? data.selected?.content ?? '';
	});
	let editing = $state(false);
	let panel = $state('editor');
	let busy = $state(false);
	let focusRange = $state(null);
	const locations = $derived(
		inspectionLocations(editing ? content : data.selected?.content || '', {
			mode: editing ? data.contentPolicy : data.selected?.governance?.policy || 'strict'
		})
	);
	const openWikifier = getContext('openWikifier');
	$effect(() => {
		data.selected?.id;
		editing = !!form?.editing;
		busy = false;
	});
	const reasons = $derived([
		...(data.selected?.governance?.regex?.reasons || []),
		...(data.selected?.governance?.semantic?.reasons || [])
	]);
</script>

<svelte:head
	><title>{data.selected ? `${data.selected.title} · 초안 검토` : '초안 검토'} — 위키비키</title
	></svelte:head
>
<main class="page-shell" class:draft-workspace={!!data.selected}>
	<div class="breadcrumbs">
		<a href="/">위키비키</a><span>/</span><a href="/drafts">초안 검토</a>{#if data.selected}<span
				>/</span
			><span>{data.selected.title}</span>{/if}
	</div>
	{#if data.databaseError}<div class="notice warning">
			{data.databaseError}
		</div>{/if}{#if form?.message}<div class="notice warning" role="alert">{form.message}</div>{/if}
	{#if data.selected}
		{#if data.updated}<div class="notice" role="status">검토 내용을 저장했습니다.</div>{/if}
		<div class="notice draft-banner">
			<span
				><strong
					>{data.selected.governance?.generationMode === 'basic'
						? '원문을 보존한 기본 초안입니다.'
						: 'AI 위키파이어 초안입니다.'}</strong
				>
				「{data.selected.source_name || '직접 작성'}」에서 생성되었습니다. 검토 후 게시해 주세요.</span
			><button class="secondary-button" onclick={() => (editing = !editing)}
				>{editing ? '읽기로 돌아가기' : '수정하기'}</button
			>
		</div>
		{#if data.siblings?.length}<nav class="tag-list" aria-label="같은 업로드의 초안">
				<span>업로드 #{data.selected.wv_upload_job_id}</span>{#each data.siblings as sibling}<a
						class="tag"
						class:active={sibling.id === data.selected.id}
						href={`?open=${sibling.id}`}
						>{sibling.title} {sibling.status === 'published' ? '· 게시됨' : ''}</a
					>{/each}
			</nav>{/if}
		<div class="review-tabs" aria-label="초안 작업 영역">
			{#each [{ id: 'list', name: '초안 목록' }, { id: 'editor', name: '편집·검토' }, { id: 'source', name: '원문 근거' }] as view}<button
					type="button"
					class="secondary-button"
					aria-pressed={panel === view.id}
					onclick={() => (panel = view.id)}>{view.name}</button
				>{/each}
		</div>
		<div class="review-layout" data-panel={panel}>
			<nav class="review-list card" aria-label="검토할 초안 목록">
				<h2>초안 목록</h2>
				{#each data.drafts as draft}<a
						class="list-link"
						class:active={draft.id === data.selected.id}
						href={`?open=${draft.id}`}>{draft.title}</a
					>{/each}<a href="/drafts">상태별 전체 목록 →</a>
			</nav>
			<div class="article-grid">
				<article>
					<h1 class="article-title">{data.selected.title}</h1>
					<p class="article-aliases">{data.selected.aliases?.join(' · ')}</p>
					<div class="article-meta">
						<span
							>{data.selected.field} · {data.selected.editor_handle} · {relativeTime(
								data.selected.updated_at
							)}</span
						><span class="tag tag-green"
							>{data.selected.status === 'blocked' ? '게시 차단' : '검토 대기'}</span
						>
					</div>
					{#if editing}
						<form
							method="POST"
							action={`?/update&open=${data.selected.id}`}
							bind:this={editForm}
							use:enhance={enhanceSave}
						>
							<FormRecovery
								element={editForm}
								storageKey={`draft:${data.selected.id}`}
								kind="draft"
								resources={[{ type: 'draft', id: data.selected.id }]}
							/>
							<input type="hidden" name="id" value={data.selected.id} /><input
								type="hidden"
								name="version"
								value={form?.version ?? data.selected.version}
							/>
							<div class="form-row">
								<div class="field">
									<label for="title">제목</label><input
										id="title"
										name="title"
										value={form?.title ?? data.selected.title}
										required
									/>
								</div>
								<div class="field">
									<label for="field">분야</label><select
										id="field"
										name="field"
										value={form?.field ?? data.selected.field}
										>{#each fields as field}<option>{field}</option>{/each}</select
									>
								</div>
							</div>
							<div class="field">
								<label for="description">바로 읽히는 설명</label><input
									id="description"
									name="description"
									value={form?.description ?? data.selected.description}
								/>
							</div>
							<div class="field">
								<MarkdownEditor
									bind:value={content}
									original={data.selected.content}
									{focusRange}
								/>
							</div>
							<div class="field">
								<label for="aliases">다른 이름 · 약어</label><input
									id="aliases"
									name="aliases"
									value={form?.aliases ?? data.selected.aliases?.join(', ')}
								/>
							</div>
							<div class="field">
								<label for="tags">태그 · 쉼표로 구분</label><input
									id="tags"
									name="tags"
									value={form?.tags ?? data.selected.tags?.join(', ') ?? ''}
									maxlength="820"
								/>
							</div>
							<ActorIdentity id="editor" label="검토자" value={form?.editor ?? 'Operator-07'} />
							<div class="button-row"><button class="primary-button">검토 내용 저장</button></div>
						</form>
					{:else}<div class="wiki-content">{@html data.html}</div>
						<section class="edit-invitation">
							<div>
								<h3>마지막 확인, 그리고 함께 읽기</h3>
								<p>정확한 설명과 연결된 용어를 확인해 주세요.</p>
							</div>
							<button class="secondary-button" onclick={() => (editing = true)}>한 줄 고치기</button
							>
						</section>
						<section class="card" aria-label="게시 전 확인">
							<h2>게시 전 확인</h2>
							<p>
								{data.selected.source_name
									? `자료명: ${data.selected.source_name}`
									: '출처가 등록되지 않았습니다.'} · 추출 원문 {data.sources?.length || 0}구간
							</p>
							<p>
								{data.selected.content.includes('[검토 필요]')
									? '[검토 필요] 표시가 남아 있습니다. 사실을 확인해 주세요.'
									: '[검토 필요] 표시 없음 · 사실 검증 완료를 뜻하지 않습니다.'}
							</p>
							{#if data.targets?.some((t) => t.recommended)}<p>
									같은 이름·별칭의 기존 문서가 있습니다. 아래 AI 통합 후보를 확인해 주세요.
								</p>{/if}
							{#if data.missingLinks?.length}<details>
									<summary>아직 없는 연결 {data.missingLinks.length}개</summary>
									<ul>
										{#each data.missingLinks as title}<li>{title}</li>{/each}
									</ul>
								</details>{/if}
						</section>
						<form
							method="POST"
							action={`?/publish&open=${data.selected.id}`}
							onsubmit={() => (busy = true)}
							class="card"
							style="margin-top:24px"
						>
							<input type="hidden" name="id" value={data.selected.id} /><input
								type="hidden"
								name="version"
								value={form?.version ?? data.selected.version}
							/>
							<ActorIdentity id="reviewer" label="검토자" value={form?.editor ?? 'Operator-07'} />
							<label style="font-size:14px;display:flex;gap:10px;align-items:baseline"
								><input type="checkbox" name="reviewed" value="yes" required /> 원문과 초안의 내용을 검토했으며
								게시에 동의합니다.</label
							>
							<div class="button-row" style="margin-top:20px">
								<button
									class="secondary-button"
									formaction={`?/markReviewed&open=${data.selected.id}`}
									disabled={busy || data.selected.status === 'blocked'}
									>검토 완료 기록 · 나중에 선택 게시</button
								>
								<a class="secondary-button" href="/drafts">나중에</a><button
									class="primary-button"
									disabled={busy || data.selected.status === 'blocked'}
									>{busy ? '게시 전 확인 중…' : '게시하기'}</button
								>
							</div>
						</form>
						<DraftMerge
							targetQuery={data.targetQuery}
							draft={data.selected}
							targets={data.targets}
							changes={data.mergeDiff}
							{form}
						/>
					{/if}
				</article>
				<aside class="article-aside">
					<section class="card source-comparison">
						<h2>원문 대조</h2>
						<p class="muted">
							같은 업로드에서 추출한 원문입니다. 초안 문장별 근거를 자동으로 확정한 것은 아닙니다.
						</p>
						{#each data.sources || [] as source}<details>
								<summary>{source.label}</summary>
								<pre class="source-excerpt">{source.text}</pre>
							</details>{:else}<p>
								이 초안은 추출 원문 기록이 없습니다. 원본 자료와 직접 대조해 주세요.
							</p>{/each}
					</section>

					<Toc items={data.toc} />
					<section class="card">
						<h4>출처</h4>
						<p class="source-text">{data.selected.source_name || '직접 작성'}</p>
					</section>
					<section class="card related-card">
						<h4>콘텐츠 검사</h4>
						{#if data.selected.governance?.policy === 'relaxed'}<p>
								개발용 완화 검사로 생성했습니다. 일반 사내 정보는 자동 차단하지 않습니다.
							</p>{/if}
						<p class:status-blocked={data.selected.status === 'blocked'}>
							{data.selected.status === 'blocked'
								? '민감한 내용을 수정해 주세요.'
								: '기본 검사를 통과했습니다. 담당자 검토가 필요합니다.'}
						</p>
						{#if data.selected.governance?.semantic?.skipped}<p>
								의미 기반 AI 검사는 생략되었습니다.
							</p>{/if}
						{#if data.selected.governance?.warnings?.length}<p>
								차단하지 않은 검토 항목: {data.selected.governance.warnings.join(', ')}
							</p>{/if}
						{#if locations.length}<ul>
								{#each locations as finding}<li>
										<button
											type="button"
											class="text-button"
											onclick={() => {
												editing = true;
												panel = 'editor';
												focusRange = { start: finding.start, end: finding.start + finding.length };
											}}
											>본문 {finding.line}행 · {finding.reason}{finding.severity === 'review'
												? ' · 검토 안내'
												: ''}</button
										>
									</li>{/each}
							</ul>{/if}{#if reasons.length}<p class="muted">
								아래 검사 사유의 위치를 확인할 수 없는 경우 원문과 메타데이터를 함께 확인하세요.
							</p>
							<ul>
								{#each reasons as reason}<li>{reason}</li>{/each}
							</ul>{/if}
					</section>
					<form
						method="POST"
						action="?/delete"
						onsubmit={(event) => {
							if (!confirm('이 초안을 삭제할까요? 삭제 후에는 복구할 수 없습니다.'))
								event.preventDefault();
						}}
					>
						<input type="hidden" name="id" value={data.selected.id} /><input
							type="hidden"
							name="version"
							value={form?.version ?? data.selected.version}
						/><button class="danger-button">초안 삭제</button>
					</form>
				</aside>
			</div>
		</div>
	{:else}
		<header class="document-header section-title">
			<div>
				<h1>검토를 기다리는 초안</h1>
				<p class="muted">AI가 시작한 문서에, 당신의 지식을 더해 주세요.</p>
			</div>
			<button class="primary-button" onclick={openWikifier}>새 초안 만들기</button>
		</header>
		{#if data.notFound}<div class="notice warning">
				이 초안은 이미 게시되었거나 삭제되었습니다.
			</div>{/if}
		<form method="GET" class="search-filters">
			<label
				>초안 상태 <select name="status" value={data.status || ''}
					><option value="">전체 미게시</option><option value="review">검토 대기</option><option
						value="blocked">게시 차단</option
					></select
				></label
			><button class="secondary-button">조건 적용</button>
		</form>
		{#if data.batchPublished}<p class="notice" role="status">
				선택한 초안 {data.batchPublished}개를 게시했습니다. 최근 변경에서 확인할 수 있습니다.
			</p>{/if}
		<form method="POST" action="?/publishSelected" id="publish-selected" class="card">
			<h2>검토 완료한 초안 선택 게시</h2>
			<p>
				각 초안을 열어 원문을 확인하고 검토 완료를 기록하면 선택할 수 있습니다. 변경된 초안은 다시
				검토해야 합니다. 최대 8개를 함께 게시합니다.
			</p>
			<ActorIdentity id="batch-reviewer" label="검토자" />
			<label
				><input type="checkbox" name="confirmed" value="yes" required /> 선택한 초안의 게시를 확인합니다.</label
			>
			<button class="primary-button">선택한 초안 게시</button>
		</form>
		<section class="card">
			{#each data.drafts as draft}<div class="draft-row">
					<label class="selection-label"
						><input
							form="publish-selected"
							type="checkbox"
							name="selected"
							value={`${draft.id}|${draft.version}`}
							disabled={draft.status !== 'review' || draft.review?.version !== draft.version}
							aria-label={`${draft.title} 게시 선택`}
						/>{draft.review?.version === draft.version ? '검토 기록 있음' : '검토 필요'}</label
					>
					<div>
						<h3><a href={`?open=${draft.id}`}>{draft.title}</a></h3>
						<p style="font-size:14px;margin:6px 0">{draft.description}</p>
						<small
							>{draft.source_name || '직접 작성'} · {relativeTime(draft.created_at)} ·
							<span class:status-blocked={draft.status === 'blocked'}
								>{draft.status === 'blocked' ? '게시 차단' : '검토 대기'}</span
							></small
						>
					</div>
					<a class="secondary-button" href={`?open=${draft.id}`}>검토하기 →</a>
				</div>{:else}<div class="empty-state">
					<h2>모든 검토를 마쳤습니다</h2>
					<p>기존 사내 문서를 올려 새로운 지식을 연결해 보세요.</p>
					<button class="primary-button" onclick={openWikifier}>AI 위키파이어 열기</button>
				</div>{/each}
			<nav class="pagination" aria-label="초안 목록 페이지">
				{#if data.page > 1}<a href={`?status=${data.status}&page=${data.page - 1}`}>이전</a
					>{/if}<span
					>{data.page || 1} / {Math.max(1, Math.ceil((data.total || 0) / 20))} 페이지</span
				>{#if data.page * 20 < data.total}<a href={`?status=${data.status}&page=${data.page + 1}`}
						>다음</a
					>{/if}
			</nav>
		</section>
	{/if}
</main>
