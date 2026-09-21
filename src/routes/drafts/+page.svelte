<script>
	import { getContext } from 'svelte';
	import Toc from '$lib/components/Toc.svelte';
	import { fields, relativeTime } from '$lib/wiki-utils.js';
	let { data, form } = $props();
	let editing = $state(false);
	let busy = $state(false);
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
<main class="page-shell">
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
					<form method="POST" action={`?/update&open=${data.selected.id}`}>
						<input type="hidden" name="id" value={data.selected.id} />
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
							<label for="content">본문</label><textarea id="content" name="content" required
								>{form?.content ?? data.selected.content}</textarea
							>
						</div>
						<div class="field">
							<label for="aliases">다른 이름 · 약어</label><input
								id="aliases"
								name="aliases"
								value={form?.aliases ?? data.selected.aliases?.join(', ')}
							/>
						</div>
						<div class="field">
							<label for="editor">익명 검토자 이름</label><input
								id="editor"
								name="editor"
								value={form?.editor ?? 'Operator-07'}
								required
							/>
						</div>
						<div class="button-row"><button class="primary-button">검토 내용 저장</button></div>
					</form>
				{:else}<div class="wiki-content">{@html data.html}</div>
					<section class="edit-invitation">
						<div>
							<h3>마지막 확인, 그리고 함께 읽기</h3>
							<p>정확한 설명과 연결된 용어를 확인해 주세요.</p>
						</div>
						<button class="secondary-button" onclick={() => (editing = true)}>한 줄 고치기</button>
					</section>
					<form
						method="POST"
						action={`?/publish&open=${data.selected.id}`}
						onsubmit={() => (busy = true)}
						class="card"
						style="margin-top:24px"
					>
						<input type="hidden" name="id" value={data.selected.id} />
						<div class="field">
							<label for="reviewer">익명 검토자 이름</label><input
								id="reviewer"
								name="editor"
								value="Operator-07"
								required
							/>
						</div>
						<label style="font-size:14px;display:flex;gap:10px;align-items:baseline"
							><input type="checkbox" name="reviewed" value="yes" required /> 원문과 초안의 내용을 검토했으며
							게시에 동의합니다.</label
						>
						<div class="button-row" style="margin-top:20px">
							<a class="secondary-button" href="/drafts">나중에</a><button
								class="primary-button"
								disabled={busy || data.selected.status === 'blocked'}
								>{busy ? '게시 전 확인 중…' : '게시하기'}</button
							>
						</div>
					</form>
				{/if}
			</article>
			<aside class="article-aside">
				<Toc items={data.toc} />
				<section class="card">
					<h4>출처</h4>
					<p class="source-text">{data.selected.source_name || '직접 작성'}</p>
				</section>
				<section class="card related-card">
					<h4>콘텐츠 검사</h4>
					<p class:status-blocked={data.selected.status === 'blocked'}>
						{data.selected.status === 'blocked'
							? '민감한 내용을 수정해 주세요.'
							: '기본 검사를 통과했습니다. 담당자 검토가 필요합니다.'}
					</p>
					{#if data.selected.governance?.semantic?.skipped}<p>
							의미 기반 AI 검사는 생략되었습니다.
						</p>{/if}{#if reasons.length}<ul>
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
					<input type="hidden" name="id" value={data.selected.id} /><button class="danger-button"
						>초안 삭제</button
					>
				</form>
			</aside>
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
		<section class="card">
			{#each data.drafts as draft}<div class="draft-row">
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
		</section>
	{/if}
</main>
