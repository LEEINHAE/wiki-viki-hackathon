<script>
	import { enhance } from '$app/forms';
	let { data, saving, dirty, busyAction, submitAction } = $props();
	let target = $state('');
	let reviewed = $state(false);
	$effect(() => {
		target = String(
			data.proposal?.target.id || (data.matches.length === 1 ? data.matches[0].id : '')
		);
	});
	$effect(() => {
		data.proposal?.id;
		reviewed = false;
	});
	const choices = $derived([
		...data.matches,
		...data.documents.filter((doc) => !data.matches.some((match) => match.id === doc.id))
	]);
</script>

<section class="merge-panel" aria-labelledby="merge-heading" aria-busy={saving}>
	<div class="merge-heading">
		<span class="eyebrow">기존 지식에 더하기</span>
		<h2 id="merge-heading">기존 문서와 AI 통합</h2>
		<p class="small muted">
			중복 내용은 합치고 상충하는 내용은 새 초안을 우선합니다. 적용 전에 통합안을 검토할 수
			있습니다.
		</p>
	</div>
	{#if data.matches.length}
		<div class="notice small">
			<strong>제목 또는 별칭이 일치하는 기존 문서가 있습니다.</strong>
			<div class="chips">
				{#each data.matches as match}<a
						class="chip"
						href={`/wiki/${encodeURIComponent(match.slug)}`}
						target="_blank"
						rel="noreferrer">{match.title} ↗</a
					>{/each}
			</div>
		</div>
	{/if}
	<form method="POST" action="?/merge" use:enhance={submitAction}>
		<input type="hidden" name="id" value={data.selected.id} />
		<input type="hidden" name="version" value={data.selected.version} />
		<div class="field">
			<label for="merge-target">통합할 기존 문서</label>
			<select id="merge-target" name="target" bind:value={target} required disabled={saving}>
				<option value="">문서를 선택해 주세요</option>
				{#each choices as doc}<option value={String(doc.id)}
						>{doc.title}{data.matches.some((match) => match.id === doc.id)
							? ' · 제목/별칭 일치'
							: ''}</option
					>{/each}
			</select>
			<small>제목이 달라도 같은 주제라면 직접 선택할 수 있습니다.</small>
		</div>
		<button class="secondary-button" disabled={saving || dirty || !target}>
			{busyAction === 'merge'
				? 'AI가 통합안을 만드는 중…'
				: data.proposal
					? '통합안 다시 생성'
					: 'AI 통합안 생성'}
		</button>
		{#if busyAction === 'merge'}<p class="small muted" role="status">
				두 문서를 비교하고 있습니다. 문서 길이에 따라 잠시 시간이 걸릴 수 있습니다.
			</p>{/if}
	</form>
	{#if dirty}<p class="small muted">
			초안 수정 사항을 먼저 저장해 주세요. 저장하면 이전 통합안은 초기화됩니다.
		</p>{/if}
	{#if data.proposal}
		{@const proposal = data.proposal}
		<div class="merge-review">
			<h3>통합안 검토 · {proposal.target.title}</h3>
			<p class="small">{proposal.summary}</p>
			{#if data.mergeStale}<div class="notice warning" role="alert">
					원본이 변경되어 이 통합안은 적용할 수 없습니다. 통합안을 다시 생성해 주세요.
				</div>{/if}
			<div class="conflict-heading">
				<strong>상충 내용 {proposal.conflicts.length}건</strong><span class="tag">새 초안 우선</span
				>
			</div>
			{#each proposal.conflicts as conflict}
				<div class="conflict-card">
					<strong>{conflict.topic}</strong>
					<dl>
						<dt>기존</dt>
						<dd>{conflict.previous}</dd>
						<dt>새 초안 · 적용</dt>
						<dd class="incoming">{conflict.incoming}</dd>
					</dl>
				</div>
			{:else}<p class="small muted">
					AI가 식별한 상충 내용이 없습니다. 누락된 정보가 없는지 확인해 주세요.
				</p>{/each}
			<p class="small muted">상충 내용과 통합 기록은 문서 역사에 남으며, 이전 버전도 보존됩니다.</p>
			<details class="merge-comparison">
				<summary>기존 문서와 AI 통합안 차이 보기</summary>
				<p class="small muted">
					초록 배경: 추가 · 취소선: 삭제 또는 변경. 아래에서 직접 수정한 내용은 이 비교에 포함되지
					않습니다.
				</p>
				{#if data.mergeDiff.length}<div class="diff-box">
						{#each data.mergeDiff as part}<span
								class:diff-add={part.added}
								class:diff-remove={part.removed}>{part.value}</span
							>{/each}
					</div>
				{:else}<pre class="diff-box">{proposal.baseContent}</pre>{/if}
			</details>
			{#key proposal.id}
				<form method="POST" action="?/applyMerge" use:enhance={submitAction}>
					<input type="hidden" name="id" value={data.selected.id} />
					<input type="hidden" name="version" value={data.selected.version} />
					<input type="hidden" name="proposal" value={proposal.id} />
					<div class="field">
						<label for="merge-content">최종 통합 본문</label>
						<textarea
							id="merge-content"
							name="content"
							required
							maxlength="200000"
							disabled={saving}
							oninput={() => (reviewed = false)}>{proposal.content}</textarea
						>
						<small
							>적용 전에 내용을 직접 수정할 수 있습니다. 기존 문서의 제목과 주소는 유지됩니다.</small
						>
					</div>
					<div class="field">
						<label for="merge-editor">통합 검토자 이름</label><input
							id="merge-editor"
							name="editor"
							value={data.selected.editor_handle}
							disabled={saving}
							pattern={'(?:Editor-[0-9]{2,}|Operator-[A-Z][A-Z0-9\\-]*)'}
							required
						/>
					</div>
					<label class="review-check"
						><input
							type="checkbox"
							name="reviewed"
							value="yes"
							bind:checked={reviewed}
							disabled={saving}
							required
						/>통합 본문과 상충 내용을 확인했습니다.</label
					>
					<button class="primary-button" disabled={saving || dirty || data.mergeStale || !reviewed}
						>{busyAction === 'applyMerge'
							? '검사 후 통합 적용 중…'
							: '검토 완료 · 기존 문서에 통합'}</button
					>
				</form>
			{/key}
			<form method="POST" action="?/discardMerge" use:enhance={submitAction}>
				<input type="hidden" name="id" value={data.selected.id} /><input
					type="hidden"
					name="version"
					value={data.selected.version}
				/>
				<button class="text-button" disabled={saving}>통합안 버리기</button>
			</form>
		</div>
	{/if}
</section>

<style>
	.merge-panel {
		margin: 24px 0;
		padding: 26px;
		border: 1px solid var(--line);
		border-radius: 20px;
		background: var(--bg);
	}
	.merge-heading h2 {
		margin: 8px 0;
		font-size: 22px;
	}
	.merge-heading p {
		line-height: 1.7;
	}
	.merge-panel .chips {
		margin-top: 12px;
	}
	.merge-review {
		border-top: 1px solid var(--line);
		margin-top: 24px;
		padding-top: 10px;
	}
	.merge-review h3 {
		font-size: 18px;
	}
	.conflict-heading {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 22px 0 12px;
	}
	.conflict-card {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 16px;
		margin: 10px 0;
		font-size: 13px;
		overflow-wrap: anywhere;
	}
	dl {
		display: grid;
		grid-template-columns: 90px minmax(0, 1fr);
		gap: 8px 12px;
		margin-bottom: 0;
		line-height: 1.65;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		white-space: pre-wrap;
	}
	.incoming {
		font-weight: 600;
	}
	.merge-comparison {
		margin: 22px 0;
	}
	summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	.diff-box {
		max-height: 420px;
		overflow: auto;
	}
	textarea {
		min-height: 320px;
	}
	.review-check {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin: 18px 0;
		font-size: 13px;
		line-height: 1.5;
	}
	.review-check input {
		accent-color: var(--accent);
		margin-top: 3px;
	}
	.text-button {
		margin-top: 14px;
		padding: 4px 0;
		color: var(--muted);
		background: none;
		border: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	@media (max-width: 600px) {
		.merge-panel {
			padding: 18px;
		}
		dl {
			grid-template-columns: 1fr;
			gap: 3px;
		}
		dd {
			margin-bottom: 8px;
		}
	}
</style>
