<script>
	import ActorIdentity from '$lib/components/ActorIdentity.svelte';
	import { enhance } from '$app/forms';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import FormRecovery from '$lib/components/FormRecovery.svelte';
	import { enhanceSave } from '$lib/enhance-save.js';
	import { fields } from '$lib/wiki-utils.js';
	let { data, form } = $props();
	let editForm = $state();
	let content = $state('');
	$effect(() => {
		content =
			form?.content ?? data.document?.content ?? '## 개요\n\n이곳에 문서 내용을 작성하세요.';
	});
	const title = $derived(
		form?.title ?? data.document?.title ?? data.suggestedTitle ?? data.slug.replaceAll('-', ' ')
	);
</script>

<svelte:head><title>{title} 편집 — 위키비키</title></svelte:head>
<main class="form-page">
	<div class="breadcrumbs">
		<a href="/">위키비키</a><span>/</span><span>{data.document ? '문서 편집' : '새 문서'}</span>
	</div>
	<form
		class="wiki-form"
		method="POST"
		action="?/save"
		bind:this={editForm}
		use:enhance={enhanceSave}
	>
		<input type="hidden" name="id" value={form?.id ?? data.document?.id ?? ''} />
		<input type="hidden" name="version" value={form?.version ?? data.document?.version ?? ''} />
		<FormRecovery
			element={editForm}
			storageKey={`edit:${data.slug}`}
			kind={data.document ? 'document' : 'new_document'}
			resources={data.document ? [{ type: 'document', id: data.document.id }] : []}
		/>
		<header class="document-header">
			<h1>{data.document ? '아는 것이 있다면 5분만' : '새로운 지식의 첫 문장'}</h1>
			<p class="muted">한 문장만 고쳐도 됩니다. 함께 읽을 수 있는 지식으로 남겨 주세요.</p>
		</header>
		{#if data.databaseError}<div class="notice warning">
				{data.databaseError}
			</div>{/if}{#if form?.message}<div class="notice warning" role="alert">
				{form.message}
			</div>{/if}
		<div class="form-row">
			<div class="field" style="flex:3">
				<label for="title">문서 제목</label><input id="title" name="title" value={title} required />
			</div>
			<div class="field">
				<label for="field">분야</label><select
					id="field"
					name="field"
					value={form?.field ?? data.document?.field ?? '일반'}
					>{#each fields as field}<option>{field}</option>{/each}</select
				>
			</div>
		</div>
		<div class="field">
			<label for="description">바로 읽히는 설명</label><input
				id="description"
				name="description"
				value={form?.description ?? data.document?.description ?? ''}
				placeholder="이 문서의 핵심을 한두 문장으로 설명해 주세요."
			/>
		</div>
		<div class="field">
			<label for="tags">태그 · 쉼표로 구분, 최대 20개</label><input
				id="tags"
				name="tags"
				value={form?.tags ?? data.tags ?? ''}
				maxlength="820"
			/>
			{#key `${data.slug}:${data.section || ''}`}<MarkdownEditor
					bind:value={content}
					original={data.document?.content || ''}
					focusHeading={data.section}
				/>{/key}<small>Markdown, [[위키 링크]], 표, 각주, 인용문, 코드를 지원합니다.</small>
		</div>
		{#if form?.latest}<section class="notice warning">
				<h2>먼저 저장된 최신 본문</h2>
				<pre class="diff-box">{form.latest.content}</pre>
				<p>내 본문과 비교한 뒤 최신 버전에 다시 적용할 수 있습니다.</p>
				<button
					type="button"
					class="secondary-button"
					onclick={() => {
						editForm.elements.namedItem('version').value = form.latest.version;
					}}>최신 버전 확인 · 내 입력으로 다시 저장 준비</button
				>
			</section>{/if}
		<div class="field">
			<label for="aliases">다른 이름 · 약어</label><input
				id="aliases"
				name="aliases"
				value={form?.aliases ?? data.aliases ?? ''}
				placeholder="쉼표로 구분해 주세요."
			/><small>별칭으로 검색하거나 접근하면 이 문서로 연결됩니다.</small>
		</div>
		<div class="field">
			<label for="sourceName">출처</label><input
				id="sourceName"
				name="sourceName"
				value={form?.sourceName ?? data.document?.source_name ?? ''}
				placeholder="원본 문서명 · 페이지 또는 항목 번호"
			/>
		</div>
		<div class="form-row">
			<ActorIdentity id="editor" label="편집자" value={form?.editor ?? 'Operator-07'} />
			<div class="field">
				<label for="summary">변경 요약</label><input
					id="summary"
					name="summary"
					value={form?.summary ?? ''}
					placeholder="무엇을 변경했나요?"
				/>
			</div>
		</div>
		<div class="button-row">
			<a
				class="secondary-button"
				href={data.document ? `/wiki/${encodeURIComponent(data.document.slug)}` : '/'}>취소</a
			><button class="primary-button">문서 저장</button>
		</div>
	</form>
	{#if data.document}<form
			method="POST"
			action="?/delete"
			onsubmit={(event) => {
				if (!confirm('문서를 휴지통으로 이동할까요? 이력·별칭·토론을 보존하며 복구할 수 있습니다.'))
					event.preventDefault();
			}}
		>
			<input type="hidden" name="version" value={data.document.version} /><input
				type="hidden"
				name="editor"
				value="Editor-01"
			/>
			<div class="button-row">
				<a href="/trash">휴지통</a><button class="danger-button">휴지통으로 이동</button>
			</div>
		</form>{/if}
</main>
