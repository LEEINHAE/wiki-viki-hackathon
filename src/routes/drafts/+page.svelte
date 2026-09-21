<script>
	import StatusNotice from '$lib/components/StatusNotice.svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { untrack, tick, onDestroy } from 'svelte';
	import { formatDate } from '$lib/knowledge.js';
	import { normalizeMergeText } from '$lib/merge-history.js';
	import MergeReview from '$lib/components/MergeReview.svelte';
	import EditRecovery from '$lib/components/EditRecovery.svelte';
	import DraftReviewList from '$lib/components/DraftReviewList.svelte';
	import WikiEditor from '$lib/components/WikiEditor.svelte';
	import {
		draftValues,
		draftInputPending,
		draftRecoveryStore,
		validRecoveryDraftId,
		semanticRejected
	} from '$lib/draft-recovery.js';
	let { data, form } = $props();
	const scope = $derived(
		page.url.searchParams.get('open') || String(form?.id ?? data.selected?.id ?? '')
	);
	let values = $state(untrack(() => draftValues(data, form, scope))),
		baseline = $state(untrack(() => draftValues(data, null, scope)));
	let previousScope = untrack(() => scope),
		previousForm = untrack(() => form);
	let active = true,
		visit = 0;
	onDestroy(() => (active = false));
	let protectedInput = $state(
		untrack(
			() =>
				!!form?.recoveryBlocked ||
				semanticRejected(data.selected?.governance) ||
				semanticRejected(form?.governance) ||
				semanticRejected(form?.mergeGovernance)
		)
	);
	let saving = $state(false),
		action = $state(''),
		wikiEditor = $state(),
		actionError = $state('');
	let restored = $state(false),
		confirmDelete = $state(false),
		confirmResetMerge = $state(false),
		reviewEpoch = $state(0),
		recoveryEpoch = $state(0),
		recovery = $state();
	const feedback = $derived(restored ? null : form);
	const selected = $derived(
		data.selected && (!values.id || String(values.id) === String(data.selected.id))
			? data.selected
			: null
	);
	const working = $derived(
		selected || (values.id && (restored || form?.content !== undefined) ? { id: values.id } : null)
	);
	const governance = $derived(
		feedback?.governance && String(feedback.id) === String(selected?.id)
			? feedback.governance
			: selected?.governance
	);
	const blocked = $derived(selected?.status === 'blocked' || governance?.passed === false);
	const staleReview = $derived(
		!!feedback?.refreshRequired || (!!values.version && values.version !== selected?.version)
	);
	const unavailable = $derived(!selected || !!data.databaseError);
	const inputPending = $derived(draftInputPending(values, selected));
	const dirty = $derived(!draftRecoveryStore.sameValues(values, baseline));
	const proposalUsable = $derived(
		data.proposal && !data.proposal.invalid && values.proposalId === data.proposal.id
	);
	const hasFinalInput = $derived(
		!!values.proposalId || !!values.finalContent || feedback?.finalContent !== undefined
	);
	const mergePending = $derived(
		proposalUsable
			? normalizeMergeText(values.finalContent) !== normalizeMergeText(data.proposal.content) ||
					values.mergeEditor.trim() !== selected?.editor_handle
			: hasFinalInput
	);
	const replaceMergeBlocked = $derived(mergePending && !confirmResetMerge);
	const matches = $derived((data.targets || []).filter((target) => target.matched));
	const targetAvailable = $derived(
		(data.targets || []).some((target) => `${target.id}:${target.version}` === values.target)
	);
	const targetChanged = $derived(
		!!data.proposal &&
			!data.proposal.invalid &&
			values.target !== `${data.proposal.targetId}:${data.proposal.targetFingerprint}`
	);
	const conflict = $derived(
		feedback?.conflict ||
			(restored && selected && values.version !== selected.version
				? {
						title: selected.title,
						content: selected.content,
						aliases: selected.aliases,
						editor: selected.editor_handle,
						version: selected.version
					}
				: null)
	);
	const fieldsToFix = $derived([
		...new Map((governance?.fields || []).map((item) => [item.field, item])).values()
	]);
	function resetState(nextData, nextForm, newVisit = false, inspected = false) {
		values = draftValues(nextData, nextForm, scope);
		baseline = draftValues(nextData, null, scope);
		if (newVisit) {
			protectedInput = false;
			saving = false;
			action = '';
		}
		if (
			nextForm?.recoveryBlocked ||
			semanticRejected(nextData.selected?.governance) ||
			semanticRejected(nextForm?.governance) ||
			semanticRejected(nextForm?.mergeGovernance)
		)
			protectedInput = true;
		else if (
			inspected &&
			nextData.selected?.governance?.semantic?.passed &&
			!nextData.selected.governance.semantic.skipped
		)
			protectedInput = false;
		restored = false;
		confirmDelete = false;
		confirmResetMerge = false;
		actionError = '';
		reviewEpoch++;
	}
	$effect(() => {
		const currentScope = scope,
			response = form,
			currentData = data;
		if (currentScope !== previousScope) {
			visit++;
			previousScope = currentScope;
			previousForm = response;
			untrack(() => resetState(currentData, response, true));
			return;
		}
		if (response === previousForm) return;
		previousForm = response;
		if (response?.content !== undefined) values = draftValues(currentData, response, currentScope);
		if (
			response?.recoveryBlocked ||
			semanticRejected(response?.governance) ||
			semanticRejected(response?.mergeGovernance)
		)
			protectedInput = true;
		restored = false;
		confirmDelete = false;
		confirmResetMerge = false;
		untrack(() => reviewEpoch++);
	});
	function restoreValues(recovered) {
		values = recovered;
		restored = true;
		confirmDelete = false;
		confirmResetMerge = false;
		actionError = '';
		reviewEpoch++;
	}
	function submitAction({ formElement, submitter, cancel }) {
		if (saving || unavailable || (staleReview && submitter?.name !== 'resolveVersion')) {
			cancel();
			return;
		}
		const submittedRecovery = recovery,
			submittedVisit = visit,
			submittedValues = draftRecoveryStore.copyValues(values);
		const submittedAction =
			(submitter?.getAttribute('formaction') || formElement.action).split('?/')[1]?.split('&')[0] ||
			'update';
		submittedRecovery?.beforeSubmit();
		saving = true;
		action = submittedAction;
		actionError = '';
		return async ({ result, update }) => {
			try {
				// A response for a draft we left must not reset another draft's current input.
				if (!active || submittedVisit !== visit) return;
				if (result.type === 'error') {
					actionError =
						'처리 결과를 확인하지 못했습니다. 입력을 유지했습니다. 연결과 초안 상태를 확인한 뒤 다시 시도해 주세요.';
					return;
				}
				if (result.type === 'redirect') submittedRecovery?.complete(submittedAction !== 'delete');
				await update({ reset: false });
				if (result.type === 'redirect' && active) {
					await tick();
					if (!active) return;
					if (semanticRejected(data.selected?.governance))
						submittedRecovery?.reject(submittedValues);
					resetState(data, null, false, ['update', 'generateMerge'].includes(submittedAction));
					previousScope = scope;
					previousForm = form;
					recoveryEpoch++;
				}
			} finally {
				if (active && submittedVisit === visit) {
					saving = false;
					action = '';
				}
			}
		};
	}
</script>

<svelte:head><title>초안 검토 — 위키비키</title></svelte:head>
<main
	class="form-page work-page"
	class:review-list-page={!working}
	class:draft-editor-page={!!working}
>
	<section class="wiki-form" aria-busy={saving}>
		<header class="document-header">
			<span class="eyebrow">함께 완성하는 지식</span>
			<h1>{selected ? selected.title : working ? '작성 중 내용 보관' : '초안 한눈에 검토'}</h1>
			<p class="muted small">
				{selected
					? `원본: ${selected.source_name || '직접 작성'} · ${formatDate(selected.created_at)}`
					: working
						? '입력을 복사해 보관하고 초안의 현재 상태를 확인해 주세요.'
						: '본문을 읽고 초안을 선택하세요. 여러 초안을 한 번에 게시하거나 삭제할 수 있습니다.'}
			</p>
		</header>
		{#if validRecoveryDraftId(scope)}
			{#key scope + ':' + recoveryEpoch}
				<EditRecovery
					bind:this={recovery}
					{scope}
					{values}
					{dirty}
					{saving}
					blocked={protectedInput}
					store={draftRecoveryStore}
					subject="초안"
					onrestore={restoreValues}
					recoveryHint="초안 입력과 최종 통합 편집을 함께 복구합니다. 복구는 저장·게시·통합이 아니며 검토 확인은 다시 선택해야 합니다."
				/>
			{/key}
		{/if}
		{#if data.databaseError}<StatusNotice tone="error" role="alert">
				초안을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
			</StatusNotice>{/if}
		{#if (feedback?.message && !['publishBatch', 'deleteBatch'].includes(feedback.action)) || actionError}<StatusNotice
				tone="error"
				role="alert"
			>
				{actionError || feedback.message}
			</StatusNotice>{/if}
		{#if staleReview || data.missingSelection}<StatusNotice tone="warning" role="status">
				<p>
					{data.databaseError
						? '초안의 현재 상태를 확인할 수 없습니다. 복구한 입력을 복사해 보관하고 다시 불러와 주세요.'
						: selected
							? '최신 초안을 다시 확인해 주세요. 작성 중인 입력은 아래에 유지했습니다.'
							: '선택한 초안이 없거나 이미 게시·삭제되었습니다.'}
				</p>
				{#if values.id}<a
						class="text-link"
						href={'/drafts?open=' + encodeURIComponent(values.id)}
						data-sveltekit-reload>최신 초안 다시 열기</a
					>{/if}
			</StatusNotice>{/if}
		{#if working}
			{#if selected && !staleReview}<StatusNotice
					tone={staleReview || blocked || governance?.semantic?.skipped ? 'warning' : 'info'}
					role="status"
				>
					<strong
						>{staleReview
							? '다시 검토한 뒤 저장·게시·삭제할 수 있습니다.'
							: governance?.semantic?.unavailable
								? '검사를 완료하지 못했습니다. 다시 저장해 주세요.'
								: blocked
									? '게시 전 확인이 필요합니다.'
									: '검토 후 게시할 수 있는 초안입니다.'}</strong
					>
					<p class="small">
						저장된 내용의 검사 결과입니다. 필요한 부분을 수정한 뒤 다시 저장해 주세요.
					</p>
					{#if governance?.semantic?.skipped}<p class="small">
							AI 의미 기반 검사는 실행되지 않았습니다. 내용을 직접 확인해 주세요.
						</p>{/if}
					{#each [...(governance?.regex?.reasons || []), ...(governance?.semantic?.reasons || [])] as reason}<p
							class="small"
						>
							· {reason}
						</p>{/each}
					{#each fieldsToFix as item}<a
							href={`#${item.field}`}
							onclick={item.field === 'content' ? () => wikiEditor?.focusEditor() : undefined}
							>{item.label} 수정하기</a
						>{/each}
				</StatusNotice>{/if}
			{#if selected && data.siblings?.length}<div class="sibling-drafts">
					<p class="small muted">같은 원본에서 만든 초안</p>
					<div class="chips">
						{#each data.siblings as sibling}<a class="chip" href={`?open=${sibling.id}`}
								>{sibling.title} ↗</a
							>{/each}
					</div>
				</div>{/if}
			{#if selected}<details class="saved-preview">
					<summary>저장된 초안과 비교</summary>
					<p class="small muted">
						현재 서버에 저장된 본문입니다. 아래에서 편집 중인 입력과 구분해 확인하세요.
					</p>
					<article class="wiki-content wiki-preview" aria-label="저장된 초안 본문">
						{@html data.previewHtml}
					</article>
				</details>{/if}
			<form method="POST" action={`?/update&open=${working.id}`} use:enhance={submitAction}>
				<input type="hidden" name="id" value={values.id} />
				<input type="hidden" name="version" value={values.version} />
				<input type="hidden" name="proposalId" value={values.proposalId} />
				{#if conflict && selected}<section
						class="notice warning"
						aria-label="현재 저장된 초안과 비교"
					>
						<h2>현재 저장된 초안</h2>
						<p>{conflict.title} · {conflict.editor}</p>
						<div class="field">
							<label for="current-content">현재 저장된 본문</label><textarea
								id="current-content"
								class="comparison-content"
								readonly>{conflict.content}</textarea
							>
						</div>
						<p>현재 별칭: {conflict.aliases?.join(', ') || '없음'}</p>
						<p>
							아래는 내가 작성한 입력입니다. 현재 저장본과 비교하고 필요한 내용을 반영한 뒤
							저장하세요.
						</p>
						<button
							class="secondary-button"
							name="resolveVersion"
							value={conflict.version}
							disabled={saving || unavailable || replaceMergeBlocked}
							>비교 후 내 수정 내용 저장</button
						>
					</section>{/if}
				<div class="field">
					<label for="title">문서 제목</label><input
						id="title"
						name="title"
						bind:value={values.title}
						disabled={saving}
						required
					/>
				</div>
				<WikiEditor
					bind:this={wikiEditor}
					bind:content={values.content}
					title={values.title}
					scope={`${scope}:edit`}
					dirty={inputPending}
					saved={!!selected}
					unavailable={unavailable || staleReview}
					disabled={saving}
					anchorPrefix={`draft-${values.id}-edit-`}
					draft={{ id: values.id, mode: 'edit', title: values.title, aliases: values.aliases }}
				/>
				<p class="small muted">초안 본문은 200,000자까지 저장합니다.</p>
				<div class="field">
					<label for="aliases">별칭 (줄마다 하나)</label><textarea
						id="aliases"
						class="alias-input"
						name="aliases"
						disabled={saving}
						rows="3"
						bind:value={values.aliases}></textarea><small
						>민감한 별칭을 수정하거나 지울 수 있습니다. 쉼표가 포함된 별칭은 한 줄에 적어 주세요.</small
					>
				</div>
				<div class="field">
					<label for="editor">검토자 이름</label><input
						id="editor"
						name="editor"
						bind:value={values.editor}
						disabled={saving}
						pattern={'(?:Editor-[0-9]{2,}|Operator-[A-Z][A-Z0-9\\-]*)'}
						required
					/>
				</div>
				{#if mergePending}<StatusNotice tone="warning" role={null}>
						<p>
							최종 통합 본문 또는 검토자를 편집했습니다. 통합 적용 전에 다른 작업을 진행하면 이
							편집을 잃을 수 있습니다.
						</p>
						<label
							><input
								type="checkbox"
								name="confirmResetMerge"
								value="yes"
								bind:checked={confirmResetMerge}
								disabled={saving}
							/> 최종 통합 편집을 버리고 초안 저장·새 게시·재생성·통합안 버리기를 진행합니다.</label
						>
					</StatusNotice>{/if}
				<div class="button-row">
					<button
						class="secondary-button"
						disabled={saving || staleReview || unavailable || replaceMergeBlocked}
						>{saving && action === 'update' ? '저장 중…' : '검토 내용 저장'}</button
					>
				</div>
				<div class="draft-publish-bar">
					<a class="text-link" href="/drafts">← 목록으로</a><button
						class="primary-button"
						formaction={`?/publish&open=${working.id}`}
						disabled={saving ||
							inputPending ||
							blocked ||
							staleReview ||
							unavailable ||
							replaceMergeBlocked}
						>{action === 'publish' ? '게시 중…' : '검토 완료 · 문서 게시'}</button
					>
				</div>
				{#if selected}<section class="merge-section" aria-label="기존 문서와 AI 통합">
						<h2>기존 문서와 AI 통합</h2>
						<p>
							이름이 일치하는 문서를 추천합니다. 같은 주제의 다른 문서도 직접 선택할 수 있습니다.
						</p>
						{#if !data.mergeAvailable}<StatusNotice tone="warning" role={null}>
								AI 통합안 생성이 연결되지 않았습니다. API 키 설정 후 사용할 수 있습니다.
							</StatusNotice>{/if}
						{#if !(data.targets || []).length}<p>통합할 활성 문서가 없습니다.</p>
						{:else}
							<p class="small muted">
								{matches.length
									? `이름이 일치하는 후보 ${matches.length}개`
									: '이름이 일치하는 후보가 없습니다. 직접 선택해 주세요.'}
							</p>
							<div class="field">
								<label for="merge-target">통합할 기존 문서</label>
								<select
									id="merge-target"
									name="target"
									bind:value={values.target}
									disabled={saving || staleReview || unavailable}
								>
									<option value="">문서를 선택해 주세요</option>
									{#if values.target && !targetAvailable}<option value={values.target}
											>이전 선택 · 현재 상태를 다시 확인하세요</option
										>{/if}
									{#each data.targets as target}<option value={`${target.id}:${target.version}`}
											>{target.matched ? '추천 · ' : ''}{target.title} · /{target.slug}</option
										>{/each}
								</select>
							</div>
						{/if}
						<div class="button-row">
							<button
								class="secondary-button"
								formaction={`?/generateMerge&open=${working.id}`}
								disabled={saving ||
									replaceMergeBlocked ||
									inputPending ||
									staleReview ||
									unavailable ||
									!data.mergeAvailable ||
									!data.targets?.length}
							>
								{action === 'generateMerge'
									? '통합안 생성 중…'
									: data.proposal
										? 'AI 통합안 다시 생성'
										: 'AI 통합안 생성'}</button
							>
							{#if selected.governance?.merge}<button
									class="secondary-button"
									formaction={`?/discardMerge&open=${working.id}`}
									disabled={saving ||
										inputPending ||
										staleReview ||
										unavailable ||
										replaceMergeBlocked}>통합안 버리기</button
								>{/if}
						</div>
						{#if saving && action === 'generateMerge'}<StatusNotice tone="pending">
								두 문서를 검사하고 통합안을 생성하고 있습니다.
							</StatusNotice>{/if}
						{#if inputPending}<p class="small muted">
								작성 중인 수정 내용을 먼저 저장해 주세요.
							</p>{/if}
						{#if targetChanged}<StatusNotice tone="warning" role="status">
								대상 선택이 바뀌었습니다. 선택한 대상의 통합안을 다시 생성한 뒤 검토해 주세요.
							</StatusNotice>{/if}
						{#if data.proposal?.invalid}<StatusNotice tone="warning" role="status">
								저장된 통합안의 형식을 확인할 수 없습니다. 다시 생성해 주세요.
							</StatusNotice>{/if}
						{#if proposalUsable}{#key reviewEpoch}<MergeReview
									proposal={data.proposal}
									bind:finalContent={values.finalContent}
									bind:mergeEditor={values.mergeEditor}
									{saving}
									disabled={inputPending || staleReview || unavailable || targetChanged}
									draftId={working.id}
									{action}
									semanticAvailable={data.mergeAvailable}
									governance={feedback?.mergeGovernance}
								/>{/key}{/if}
					</section>{/if}
				{#if hasFinalInput && (!selected || !proposalUsable)}
					<section aria-label="작성 중인 최종 통합 입력">
						<h2>작성 중인 최종 통합 입력</h2>
						<p>
							기존 통합안을 사용할 수 없습니다. 아래 입력을 복사해 보관한 뒤 최신 초안을 다시 열어
							주세요.
						</p>
						<div class="field">
							<label for="preserved-final">최종 통합 본문</label><textarea
								id="preserved-final"
								name="finalContent"
								bind:value={values.finalContent}
								disabled={saving}></textarea>
						</div>
						<div class="field">
							<label for="preserved-editor">통합 검토자 이름</label><input
								id="preserved-editor"
								name="mergeEditor"
								bind:value={values.mergeEditor}
								disabled={saving}
							/>
						</div>
					</section>
				{/if}
				{#if inputPending && selected}<p class="small muted">
						수정 사항을 먼저 저장하면 문서를 게시할 수 있습니다.
					</p>{/if}
				{#if selected}<section class="delete-section" aria-label="초안 영구 삭제">
						<h2>초안 삭제</h2>
						<p>
							저장된 초안을 영구 삭제하며 서버에서 복구할 수 없습니다. 이 브라우저의 임시 입력은
							별도로 남으며 위 복구 목록에서 삭제할 수 있습니다.
						</p>
						<label
							><input
								type="checkbox"
								name="confirmDelete"
								bind:checked={confirmDelete}
								value="yes"
								disabled={saving || staleReview || unavailable}
							/> 저장된 초안을 영구 삭제하며 복구할 수 없음을 확인했습니다.</label
						>
						<div class="button-row">
							<button
								class="danger-button"
								formaction={`?/delete&open=${working.id}`}
								formnovalidate
								disabled={saving || staleReview || unavailable}
								>{action === 'delete' ? '삭제 중…' : '초안 삭제'}</button
							>
						</div>
					</section>{/if}
			</form>
		{:else if !data.databaseError}
			<DraftReviewList list={data.reviewList} drafts={data.drafts} {form} />
		{/if}
	</section>
</main>

<style>
	.review-list-page {
		max-width: 1120px;
	}
	.draft-editor-page {
		max-width: 1480px;
	}
	.saved-preview {
		margin: 1rem 0;
		padding: 1rem;
		border: 1px solid var(--line);
		border-radius: 12px;
	}
	.saved-preview summary {
		cursor: pointer;
	}
	.saved-preview p {
		margin-top: 0.75rem;
	}
	.merge-section {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--line);
	}
	select {
		width: 100%;
		min-width: 0;
	}
	.alias-input {
		min-height: 6rem;
	}
	.comparison-content {
		min-height: 8rem;
		max-height: 20rem;
	}
	.delete-section {
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--line);
	}
	.delete-section label {
		display: flex;
		align-items: start;
		gap: 0.5rem;
	}
	.delete-section input {
		margin-top: 0.3rem;
	}
</style>
