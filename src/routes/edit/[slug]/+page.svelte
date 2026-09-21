<script>
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { enhance } from '$app/forms';
	import { onDestroy, untrack } from 'svelte';
	import EditRecovery from '$lib/components/EditRecovery.svelte';
	import WikiEditor from '$lib/components/WikiEditor.svelte';
	import { editValues, sameEditValues } from '$lib/edit-recovery.js';
	let { data, form } = $props();
	let saving = $state(false);
	let deleting = $state(false);
	let transportError = $state('');
	let recovery = $state();
	let wikiEditor = $state();
	let values = $state(untrack(() => editValues(data, form)));
	let baseline = $state(untrack(() => editValues(data)));
	let restored = $state(false);
	let confirmDelete = $state(false);
	let previousScope = untrack(() => data.slug);
	let previousForm = untrack(() => form);
	let active = true,
		visit = 0;
	onDestroy(() => (active = false));
	const feedback = $derived(restored ? null : form);
	const title = $derived(values.title);
	const dirty = $derived(!sameEditValues(values, baseline));
	const semanticRejected = (governance) =>
		!!governance &&
		!governance.semantic.passed &&
		!governance.semantic.skipped &&
		!governance.semantic.unavailable;
	let protectedInput = $state(untrack(() => semanticRejected(form?.governance)));
	const fieldsToFix = $derived([
		...new Map((feedback?.governance?.fields ?? []).map(({ field, label }) => [field, label]))
	]);
	$effect(() => {
		const currentData = data,
			response = form;
		// Background invalidation must not replace an in-progress edit or approve a newer version.
		if (currentData.slug === previousScope && response === previousForm) return;
		if (currentData.slug !== previousScope) {
			visit++;
			protectedInput = false;
			saving = false;
			deleting = false;
			transportError = '';
		}
		if (semanticRejected(response?.governance)) protectedInput = true;
		else if (response?.governance?.semantic.passed && !response.governance.semantic.skipped)
			protectedInput = false;
		previousScope = currentData.slug;
		previousForm = response;
		baseline = editValues(currentData);
		values = editValues(currentData, response);
		restored = false;
		confirmDelete = false;
	});
	function restoreValues(recovered) {
		values = recovered;
		restored = true;
		confirmDelete = false;
		transportError = '';
	}
	function save({ submitter, cancel }) {
		if (saving) {
			cancel();
			return;
		}
		deleting = submitter?.getAttribute('formaction') === '?/delete';
		const submittedRecovery = recovery,
			submittedVisit = visit,
			isDeletion = deleting;
		submittedRecovery?.beforeSubmit();
		saving = true;
		transportError = '';
		return async ({ result, update }) => {
			try {
				// A response from an earlier visit must not replace the current editor's input or state.
				if (!active || submittedVisit !== visit) return;
				if (result.type === 'error') {
					transportError =
						'저장 결과를 확인하지 못했습니다. 입력 내용을 유지했습니다. 연결과 문서의 현재 상태를 확인한 뒤 다시 시도해 주세요.';
					return;
				}
				if (result.type === 'redirect') submittedRecovery?.complete(!isDeletion);
				await update({ reset: false });
			} finally {
				if (active && submittedVisit === visit) {
					saving = false;
					deleting = false;
				}
			}
		};
	}
</script>

<svelte:head><title>{title} 편집 — Wiki Viki</title></svelte:head>

<main class="form-page work-page">
	<header class="document-header">
		<h1>
			{data.trashed
				? '휴지통에 있는 문서'
				: `${data.document ? '문서 편집' : '문서 만들기'}: ${title}`}
		</h1>
	</header>
	{#key data.slug}
		<EditRecovery
			bind:this={recovery}
			scope={data.slug}
			{values}
			{dirty}
			{saving}
			blocked={protectedInput}
			onrestore={restoreValues}
		/>
	{/key}
	{#if data.trashed}
		<section class="wiki-form">
			<p>문서와 관련 이력·별칭·토론을 보관하고 있습니다. 복구한 뒤 편집할 수 있습니다.</p>
			<a class="primary-button" href={'/trash?open=' + data.trashed.id}>휴지통에서 확인</a>
		</section>
	{/if}
	{#if !data.trashed || form?.content !== undefined || restored}
		<form class="wiki-form" method="POST" action="?/save" use:enhance={save} aria-busy={saving}>
			<input type="hidden" name="version" value={values.version} />
			<input type="hidden" name="documentId" value={values.documentId} />
			<input type="hidden" name="aliasesFormat" value={values.aliasesFormat} />
			{#if data.trashed}
				<h2>작성 중 내용 보관: {title}</h2>
			{/if}
			{#if data.databaseError}
				<StatusNotice tone="error" role="alert">{data.databaseError}</StatusNotice>
			{/if}
			{#if transportError || feedback?.message}
				<StatusNotice tone="error" role="alert">
					<p>{transportError || feedback.message}</p>
					{#if !transportError && feedback?.governance && !feedback.governance.passed}
						<ul>
							{#each [...feedback.governance.regex.reasons, ...feedback.governance.semantic.reasons] as reason}
								<li>{reason}</li>
							{/each}
						</ul>
						{#each fieldsToFix as [field, label]}
							<p>
								<a
									href={'#' + field}
									onclick={field === 'content' ? () => wikiEditor?.focusEditor() : undefined}
									>{label} 수정하기</a
								>
							</p>
						{/each}
					{/if}
				</StatusNotice>
			{/if}
			{#if feedback?.conflict}
				<section class="notice warning" aria-label="현재 저장본과 비교">
					<h2>현재 저장된 문서</h2>
					<p><strong>{feedback.conflict.title}</strong></p>
					<div class="field">
						<label for="current-content">현재 저장된 본문</label>
						<textarea id="current-content" class="comparison-content" readonly
							>{feedback.conflict.content}</textarea
						>
					</div>
					<p>현재 별칭: {feedback.conflict.aliases.join(', ') || '없음'}</p>
					<p>
						아래 입력은 내가 작성한 내용입니다. 필요한 변경을 반영한 뒤 비교를 마치고 저장하세요.
					</p>
					<button
						class="secondary-button"
						name="resolveVersion"
						value={feedback.conflict.version}
						disabled={saving || !!data.databaseError || !!data.trashed}
						>비교 후 내 수정 내용 저장</button
					>
				</section>
			{/if}
			{#if !data.trashed && (!data.semanticAvailable || (feedback?.governance?.regex.passed && feedback?.governance?.semantic.skipped))}
				<StatusNotice tone="warning" role="status">
					AI 의미 기반 검사는 실행되지 않습니다. 기본 콘텐츠 보호 검사만 적용되므로
					제목·본문·별칭·편집 요약을 직접 검토한 뒤 저장해 주세요.
				</StatusNotice>
			{/if}
			<div class="field">
				<label for="title">문서 제목</label>
				<input id="title" name="title" bind:value={values.title} required disabled={saving} />
			</div>
			<WikiEditor
				bind:this={wikiEditor}
				bind:content={values.content}
				{title}
				scope={data.slug}
				{dirty}
				saved={!!data.document}
				unavailable={!!data.databaseError}
				document={data.databaseError
					? undefined
					: {
							id: values.documentId,
							title: values.title,
							aliases: values.aliases,
							aliasesFormat: values.aliasesFormat
						}}
				disabled={saving}
			/>
			<div class="field">
				<label for="aliases">넘겨주기 별칭</label>
				<textarea
					id="aliases"
					name="aliases"
					class="alias-input"
					rows="3"
					disabled={saving}
					bind:value={values.aliases}></textarea>
				<small
					>별칭을 줄마다 하나씩 입력하세요. 쉼표가 있는 별칭도 한 줄로 유지합니다. 입력에서 지운
					별칭은 저장할 때 제거됩니다.</small
				>
			</div>
			<div class="form-row">
				<div class="field">
					<label for="editor">익명 편집자 이름</label>
					<input id="editor" name="editor" bind:value={values.editor} required disabled={saving} />
				</div>
				<div class="field">
					<label for="summary">편집 요약</label>
					<input
						id="summary"
						name="summary"
						bind:value={values.summary}
						placeholder="무엇을 변경했나요?"
						disabled={saving}
					/>
				</div>
			</div>
			<div class="button-row">
				<a class="secondary-button" href={data.document ? '/wiki/' + data.document.slug : '/'}
					>취소</a
				>
				<button
					class="primary-button"
					disabled={saving ||
						!!data.databaseError ||
						!!data.trashed ||
						!!feedback?.conflict ||
						feedback?.missingTarget}>{saving && !deleting ? '저장 중…' : '문서 저장'}</button
				>
			</div>
			{#if data.document}
				<section class="delete-section" aria-label="문서를 휴지통으로 이동">
					<h2>문서를 휴지통으로 이동</h2>
					<p>
						저장된 문서와 리비전·별칭·토론을 보관하며, 휴지통에서 복구할 수 있습니다. 현재 입력한
						미저장 내용은 포함되지 않습니다.
					</p>
					<label
						><input
							type="checkbox"
							name="confirmDelete"
							bind:checked={confirmDelete}
							value="yes"
							disabled={saving || !!feedback?.deleteReviewRequired}
						/> 저장된 문서를 휴지통으로 이동하는 것을 확인했습니다.</label
					>
					<div class="button-row">
						<button
							class="danger-button"
							formaction="?/delete"
							formnovalidate
							disabled={saving ||
								!!data.databaseError ||
								!!feedback?.conflict ||
								feedback?.missingTarget ||
								!!feedback?.deleteReviewRequired}
							>{deleting ? '휴지통으로 이동 중…' : '휴지통으로 이동'}</button
						>
					</div>
					{#if feedback?.deleteReviewRequired}<p role="status">
							입력을 복사해 보관한 뒤 <a
								href={'/edit/' + encodeURIComponent(data.slug)}
								data-sveltekit-reload>현재 문서 다시 열기</a
							>로 삭제할 버전을 다시 확인해 주세요.
						</p>{/if}
				</section>
			{/if}
		</form>
	{/if}
</main>

<style>
	.form-page {
		max-width: 1440px;
	}
	.delete-section {
		border-top: 1px solid var(--line);
		margin-top: 2rem;
		padding-top: 1.25rem;
	}
	.delete-section label {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.alias-input {
		min-height: 6rem;
	}
	.comparison-content {
		min-height: 8rem;
		height: 12rem;
		max-height: 18rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
