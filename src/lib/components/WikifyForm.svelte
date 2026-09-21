<script>
	import StatusNotice from './StatusNotice.svelte';
	import { maxDraftDocuments } from '$lib/knowledge.js';
	import { onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Icon from './Icon.svelte';
	import {
		supportsUpload,
		uploadAccept,
		uploadFormatMessage,
		readUploadResponse,
		uploadUnconfirmedMessage
	} from '$lib/upload.js';
	let { oncomplete = () => {}, inModal = false } = $props();
	let file = $state(null);
	let input = $state(null);
	let editor = $state('Editor-01');
	let uploading = $state(false);
	let result = $state(null);
	let problem = $state('');
	let refreshProblem = $state('');
	let dragging = $state(false);
	let controller;
	let disposed = false;
	const id = $props.id();
	onDestroy(() => {
		disposed = true;
		controller?.abort();
	});
	function choose(candidate) {
		if (!candidate || uploading) return;
		problem = '';
		refreshProblem = '';
		result = null;
		file = null;
		if (!supportsUpload(candidate.name)) {
			problem = uploadFormatMessage;
			return;
		}
		if (candidate.size > 10 * 1024 * 1024) {
			problem = '파일 크기는 10MB 이하여야 합니다.';
			return;
		}
		if (!candidate.size) {
			problem = '내용이 없는 파일입니다. 다른 파일을 선택해 주세요.';
			return;
		}
		file = candidate;
	}
	async function submit(event) {
		event.preventDefault();
		if (!file || uploading) return;
		uploading = true;
		problem = '';
		refreshProblem = '';
		result = null;
		controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 120000);
		try {
			const form = new FormData();
			form.set('file', file);
			form.set('editor', editor);
			const response = await fetch('/api/wikify', {
				method: 'POST',
				body: form,
				signal: controller.signal
			});
			const payload = await readUploadResponse(response);
			if (disposed) return;
			result = payload;
			// A page refresh failure must not turn a confirmed save into an upload failure.
			try {
				await invalidateAll();
			} catch {
				refreshProblem =
					'초안은 저장됐습니다. 화면을 새로 고치지 못했으니 아래 초안 링크로 확인해 주세요.';
			}
		} catch (error) {
			if (disposed) return;
			problem =
				error.name === 'AbortError'
					? '처리가 지연되고 있습니다. 초안 검토 목록을 먼저 확인한 뒤 다시 시도해 주세요.'
					: error instanceof TypeError
						? uploadUnconfirmedMessage
						: error.message || uploadUnconfirmedMessage;
		} finally {
			clearTimeout(timeout);
			uploading = false;
		}
	}
</script>

<div class="wikifier-intro">
	<span class="eyebrow"><Icon name="sparkles" size={18} /> AI WIKIFIER</span>
	<h1>백지에서 시작하지 마세요.</h1>
	<p>파일 하나를 세부 작업·점검 항목·개념별로 나누어, 각각의 위키 초안으로 만듭니다.</p>
</div>
<ol class="upload-steps" aria-label="변환 단계">
	<li class:active={!uploading && !result}><span>1</span> 문서 업로드</li>
	<li class:active={uploading}><span>2</span> 초안 생성</li>
	<li class:active={!!result}><span>3</span> 검토 및 게시</li>
</ol>
{#if result}
	<div class="upload-success work-page">
		<span class="success-icon"><Icon name="check" size={30} /></span>
		<h2>{result.count}개의 초안이 준비됐어요.</h2>
		<p>원본: {file.name}</p>
		{#if refreshProblem}<StatusNotice tone="warning" role="status">{refreshProblem}</StatusNotice
			>{/if}
		{#if !result.aiGenerated}<StatusNotice tone="info" role={null}>
				AI가 연결되지 않아 원문을 기본 초안 하나로 준비했습니다. 직접 나누고 정리해 주세요.
			</StatusNotice>{/if}
		{#if result.semanticSkipped}<StatusNotice tone="warning" role="status">
				AI 의미 기반 검사는 실행되지 않았습니다. 게시 전에 내용을 직접 확인해 주세요.
			</StatusNotice>{/if}
		<div class="generated-drafts">
			{#each result.drafts as draft}<a
					class="generated-draft"
					href={`/drafts?open=${draft.id}`}
					onclick={oncomplete}
					><Icon name="file" />
					<div>
						<strong>{draft.title}</strong><small
							>{draft.status === 'blocked' ? '콘텐츠 확인 필요' : '검토 대기'} · {result.aiGenerated
								? 'AI 초안'
								: '기본 초안'} · 연결 {draft.linkCount}개</small
						>
					</div>
					<Icon name="arrow" /></a
				>{/each}
		</div>
		<p class="muted">
			각 초안은 별도의 위키 문서가 됩니다. 목록에서 내용을 확인하고 여러 초안을 선택해 게시할 수
			있습니다.
		</p>
		<div class="button-row">
			<button
				class="secondary-button"
				disabled={uploading}
				onclick={() => {
					result = null;
					file = null;
				}}>다른 문서 올리기</button
			><a class="primary-button" href="/drafts" onclick={oncomplete}>전체 초안 검토하기 →</a>
		</div>
	</div>
{:else}
	<form onsubmit={submit}>
		<input
			bind:this={input}
			type="file"
			accept={uploadAccept}
			class="sr-only"
			tabindex="-1"
			aria-label="업로드 파일"
			disabled={uploading}
			onchange={(event) => choose(event.currentTarget.files?.[0])}
		/>
		<button
			type="button"
			class="upload-zone"
			class:dragging
			disabled={uploading}
			onclick={() => input.click()}
			ondragover={(event) => {
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={(event) => {
				event.preventDefault();
				dragging = false;
				choose(event.dataTransfer.files[0]);
			}}
		>
			<span class="upload-icon"><Icon name={file ? 'file' : 'upload'} size={28} /></span><strong
				>{file ? file.name : '파일을 끌어 놓거나 눌러서 선택하세요'}</strong
			><span
				>{file
					? `${(file.size / 1024).toFixed(1)} KB · 다른 파일을 선택하려면 클릭하세요`
					: '회의록, 설비 매뉴얼, 업무 지침, 약어집'}</span
			><small>DOCX · PDF · Excel(.xlsx) · PowerPoint(.pptx) / 최대 10MB</small>
		</button>
		<p class="small muted">
			문서·표·슬라이드의 텍스트를 읽습니다. 이미지 속 글자와 암호로 보호된 파일은 지원하지 않습니다.
			AI 연결 시 파일 하나에서 최대 {maxDraftDocuments}개의 세부 초안을 만듭니다. 더 큰 자료는
			나누어 올려 주세요.
		</p>
		<div class="field">
			<label for={`${id}-editor`}>익명 편집자 이름</label><input
				id={`${id}-editor`}
				bind:value={editor}
				required
				disabled={uploading}
				pattern={'(?:Editor-[0-9]{2,}|Operator-[A-Z][A-Z0-9\\-]*)'}
				placeholder="Editor-01 또는 Operator-A"
			/><small>Editor-01 또는 Operator-A 형식으로 입력해 주세요.</small>
		</div>
		{#if uploading}<StatusNotice tone="pending">
				<div class="indeterminate-progress"></div>
				<strong>문서를 읽고 초안을 만들고 있습니다…</strong>
				<p>
					세부 주제와 작성 범위를 찾고, 작은 단위의 초안을 작성한 뒤 연결과 콘텐츠를 확인합니다.
				</p>
				{#if inModal}<p>
						모달을 닫아도 처리는 계속됩니다. 다시 열어 결과를 확인하세요. 페이지를 새로 고치면 화면
						상태는 초기화되니 초안 검토 목록을 확인해 주세요.
					</p>{/if}
			</StatusNotice>{/if}
		{#if problem}<StatusNotice tone="error" role="alert">
				<p>{problem}</p>
				<a href="/drafts" onclick={oncomplete}>초안 검토 목록 확인하기 →</a>
			</StatusNotice>{/if}
		<div class="upload-note">
			<Icon name="sparkles" size={18} /><span
				>AI가 만든 내용은 초안으로 저장됩니다. 검토하고 고친 뒤 게시해 주세요.</span
			>
		</div>
		<button class="primary-button full-width" disabled={!file || uploading}
			>{uploading ? '초안 생성 중…' : '위키 초안 만들기'} <Icon name="arrow" size={18} /></button
		>
	</form>
{/if}
