<script>
	import StatusNotice from './StatusNotice.svelte';
	import { onMount, tick } from 'svelte';
	import Toc from './Toc.svelte';
	let {
		content = $bindable(''),
		title = '',
		document: previewDocument = undefined,
		draft = undefined,
		anchorPrefix = '',
		inputId = 'content',
		name = 'content',
		label = '위키 본문',
		required = true,
		ariaRequired = required,
		previewLabel = '현재 입력 미리보기',
		baselineLabel = '현재 저장본 기준',
		scope,
		dirty = false,
		saved = false,
		unavailable = false,
		disabled = false
	} = $props();
	const id = $props.id();
	let ready = $state(false),
		wide = $state(false),
		view = $state('edit');
	let status = $state('loading'),
		result = $state(null),
		attempt = $state(0);
	let editor = $state(),
		previewPanel = $state(),
		editTab = $state(),
		previewTab = $state();
	let imagePermission = $state(null);
	const imageIdentity = $derived(
		JSON.stringify({ content, document: previewDocument, draft, anchorPrefix, scope })
	);
	const showImages = $derived(!!draft && imagePermission === imageIdentity);
	let imageState = $state({ pending: 0, failed: 0 });
	$effect(() => {
		if (imagePermission !== null && imagePermission !== imageIdentity) imagePermission = null;
	});
	$effect(() => {
		const images =
			result && showImages && previewPanel
				? [...previewPanel.querySelectorAll('.wiki-content img')]
				: [];
		let active = true;
		const update = () => {
			if (active)
				imageState = {
					pending: images.filter((image) => !image.complete).length,
					failed: images.filter((image) => image.complete && image.naturalWidth === 0).length
				};
		};
		for (const image of images) {
			image.addEventListener('load', update);
			image.addEventListener('error', update);
		}
		update();
		return () => {
			active = false;
			for (const image of images) {
				image.removeEventListener('load', update);
				image.removeEventListener('error', update);
			}
		};
	});

	onMount(() => {
		const media = window.matchMedia('(min-width: 1024px)');
		const resize = async () => {
			const focused = document.activeElement;
			const tab = focused === editTab ? 'edit' : focused === previewTab ? 'preview' : null;
			wide = media.matches;
			if (!wide && previewPanel?.contains(focused)) view = 'preview';
			else if (!wide && focused === editor) view = 'edit';
			if (wide && tab) {
				await tick();
				// The narrow-screen tabs disappear. Keep keyboard navigation in their pane
				// without moving focus if the user has already moved elsewhere.
				if (wide && document.activeElement === document.body)
					(tab === 'edit' ? editor : previewPanel)?.focus({ preventScroll: true });
			}
		};
		resize();
		ready = true;
		media.addEventListener('change', resize);
		return () => media.removeEventListener('change', resize);
	});

	$effect(() => {
		const source = content,
			currentScope = scope;
		const requestBody = JSON.stringify({
			content: source,
			document: previewDocument,
			draft,
			anchorPrefix,
			showImages
		});
		attempt;
		if (!ready) return;
		result = null;
		if (!source.trim()) {
			status = 'empty';
			return;
		}
		status = 'loading';
		const controller = new AbortController();
		let active = true;
		const timer = setTimeout(async () => {
			const timeout = setTimeout(() => {
				if (active) {
					status = 'error';
					controller.abort();
				}
			}, 10000);
			try {
				const response = await fetch('/api/preview', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: requestBody,
					cache: 'no-store',
					signal: controller.signal
				});
				// Consume error responses too so failed previews release their request stream.
				const rendered = await response.json();
				if (!response.ok || typeof rendered.html !== 'string' || !Array.isArray(rendered.toc))
					throw new Error('Invalid preview');
				if (
					!active ||
					controller.signal.aborted ||
					content !== source ||
					scope !== currentScope ||
					JSON.stringify({
						content,
						document: previewDocument,
						draft,
						anchorPrefix,
						showImages
					}) !== requestBody
				)
					return;
				result = rendered;
				status = 'ready';
			} catch {
				if (active && !controller.signal.aborted && content === source && scope === currentScope)
					status = 'error';
			} finally {
				clearTimeout(timeout);
			}
		}, 300);
		return () => {
			active = false;
			clearTimeout(timer);
			controller.abort();
		};
	});

	function tabKey(event) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		view =
			event.key === 'Home'
				? 'edit'
				: event.key === 'End'
					? 'preview'
					: view === 'edit'
						? 'preview'
						: 'edit';
		(view === 'edit' ? editTab : previewTab)?.focus();
	}
	async function revealInvalid(event) {
		if (!wide && view === 'preview') {
			event.preventDefault();
			view = 'edit';
			await tick();
			editor.focus();
			editor.reportValidity();
		}
	}
	export async function focusEditor() {
		view = 'edit';
		await tick();
		editor?.focus();
	}
</script>

{#snippet previewContents()}
	<h2 id={`${id}-preview-heading`}>{previewLabel}</h2>
	<p class="preview-title">{title.trim() || '제목 없음'}</p>
	{#if draft}
		<label class="image-choice">
			<input
				type="checkbox"
				checked={showImages}
				{disabled}
				aria-describedby={`${id}-image-help`}
				onchange={(event) => (imagePermission = event.currentTarget.checked ? imageIdentity : null)}
			/>
			현재 미리보기의 이미지 표시
		</label>
		<p class="small muted" id={`${id}-image-help`}>
			선택하면 이미지 주소로 요청을 보냅니다. 입력을 바꾸면 다시 꺼집니다.
		</p>
	{/if}
	{#if status === 'loading'}
		<StatusNotice tone="pending" role="status">현재 입력을 미리보기로 바꾸고 있습니다…</StatusNotice
		>
	{:else if status === 'empty'}
		<StatusNotice tone="info" role="status">본문을 입력하면 미리보기가 표시됩니다.</StatusNotice>
	{:else if status === 'error'}
		<StatusNotice tone="error" role="alert">
			<p>미리보기를 불러오지 못했습니다. 입력 내용은 유지됩니다.</p>
			<button type="button" class="secondary-button" onclick={() => attempt++}
				>미리보기 다시 시도</button
			>
		</StatusNotice>
	{:else if result}
		{#if imageState.pending}
			<StatusNotice tone="pending" role="status">
				이미지 {imageState.pending}개를 불러오고 있습니다…
			</StatusNotice>
		{/if}
		{#if imageState.failed}
			<StatusNotice tone="error" role="alert">
				<p>
					이미지 {imageState.failed}개를 불러오지 못했습니다. 본문의 이미지 주소를 확인해 주세요.
				</p>
				<button type="button" class="secondary-button" onclick={() => attempt++}
					>이미지 다시 불러오기</button
				>
			</StatusNotice>
		{/if}
		<Toc items={result.toc} />
		<div class="wiki-content">{@html result.html}</div>
	{/if}
{/snippet}

<div class="wiki-editor" role="group" aria-label={`${label} 편집기`}>
	{#if ready}
		<p class="preview-note" role="status">
			{dirty
				? '미저장 변경 있음'
				: unavailable
					? '저장 상태 확인 필요'
					: saved
						? baselineLabel
						: '아직 저장하지 않은 새 문서'} · 현재 입력을 미리 봅니다.
		</p>
		<p class="small muted">
			미리보기는 앱 서버에서 문법과 링크를 확인하며, 문서 저장이나 AI 검사를 실행하지 않습니다.
			{#if draft}이미지는 기본적으로 링크로 표시합니다.{/if}
		</p>
		{#if !wide}
			<div class="editor-tabs" role="tablist" aria-label="본문 편집과 미리보기">
				<button
					bind:this={editTab}
					type="button"
					role="tab"
					id={`${id}-edit-tab`}
					aria-selected={view === 'edit'}
					aria-controls={`${id}-edit`}
					tabindex={view === 'edit' ? 0 : -1}
					onclick={() => (view = 'edit')}
					onkeydown={tabKey}>편집</button
				>
				<button
					bind:this={previewTab}
					type="button"
					role="tab"
					id={`${id}-preview-tab`}
					aria-selected={view === 'preview'}
					aria-controls={`${id}-preview`}
					tabindex={view === 'preview' ? 0 : -1}
					onclick={() => (view = 'preview')}
					onkeydown={tabKey}>미리보기</button
				>
			</div>
		{/if}
	{/if}
	<div class:side-by-side={ready && wide} class="editor-panes">
		<div
			class="field editor-input"
			id={`${id}-edit`}
			role={ready && !wide ? 'tabpanel' : undefined}
			aria-labelledby={ready && !wide ? `${id}-edit-tab` : undefined}
			hidden={ready && !wide && view !== 'edit'}
		>
			<label for={inputId}>{label}</label>
			<textarea
				bind:this={editor}
				id={inputId}
				{name}
				{required}
				aria-required={ariaRequired}
				{disabled}
				bind:value={content}
				oninvalid={revealInvalid}></textarea>
			<small
				>Markdown, <code>[[위키 링크]]</code>, 각주, 표, 인용문, 코드, ~~취소선~~을 지원합니다.</small
			>
		</div>
		{#if ready}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (Only the mobile tabpanel has tabindex 0; the desktop region has -1. Keep this node mounted to preserve focus.) -->
			<div
				bind:this={previewPanel}
				class="preview-panel wiki-preview"
				id={`${id}-preview`}
				role={wide ? 'region' : 'tabpanel'}
				aria-labelledby={wide ? `${id}-preview-heading` : `${id}-preview-tab`}
				tabindex={wide ? -1 : 0}
				hidden={!wide && view !== 'preview'}
				aria-busy={status === 'loading'}
			>
				{@render previewContents()}
			</div>
		{/if}
	</div>
	<noscript
		><p class="small muted">
			실시간 미리보기는 JavaScript가 필요합니다. 본문 작성과 문서 저장은 계속 사용할 수 있습니다.
		</p></noscript
	>
</div>

<style>
	.wiki-editor {
		margin: 20px 0;
	}
	.preview-note {
		font-weight: 600;
		margin-bottom: 6px;
	}
	.editor-tabs {
		display: flex;
		border-bottom: 1px solid var(--line);
		margin: 16px 0;
		gap: 8px;
	}
	.editor-tabs button {
		background: transparent;
		color: var(--secondary);
		border: 0;
		border-bottom: 3px solid transparent;
		padding: 12px 18px;
	}
	.editor-tabs button[aria-selected='true'] {
		color: var(--link);
		border-bottom-color: var(--accent);
		font-weight: 700;
	}
	.editor-panes {
		min-width: 0;
	}
	.editor-panes.side-by-side {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--layout-gap);
		align-items: start;
	}
	.editor-input {
		margin: 16px 0 0;
		min-width: 0;
	}
	.editor-input[hidden],
	.preview-panel[hidden] {
		display: none;
	}
	.editor-input textarea {
		min-height: 480px;
	}
	.preview-panel {
		min-width: 0;
		margin-top: 16px;
		padding: var(--inset-padding);
		border: 1px solid var(--line);
		border-radius: var(--inset-radius);
		background: var(--paper);
	}
	.preview-panel:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 4px;
	}
	.preview-panel h2 {
		font: inherit;
		font-weight: 600;
		color: var(--secondary);
		margin: 0 0 14px;
	}
	.preview-title {
		font-size: 24px;
		font-weight: 700;
		overflow-wrap: anywhere;
		margin-bottom: 18px;
	}
	.image-choice {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		font-weight: 600;
	}
	.preview-panel :global(.toc button) {
		font-family: inherit;
	}
	.preview-panel :global([id]) {
		scroll-margin-top: 150px;
	}
	@media (max-width: 600px) {
		.preview-panel {
			--inset-padding: 12px;
		}
	}
</style>
