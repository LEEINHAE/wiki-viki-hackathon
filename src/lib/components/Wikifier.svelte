<script>
	import { invalidateAll } from '$app/navigation';
	let { onclose = null } = $props();
	let step = $state(0);
	let file = $state(null);
	let dragging = $state(false);
	let progress = $state(0);
	let stage = $state('');
	let problem = $state('');
	let result = $state(null);
	let canUseBasic = $state(false);
	let editor = $state('Operator-07');
	const uid = $props.id();
	function selectFile(selected) {
		problem = '';
		if (!selected) return;
		file = null;
		if (!/\.(docx|pdf|pptx)$/i.test(selected.name)) {
			problem = 'DOCX, PDF, PPTX 파일만 지원합니다.';
			return;
		}
		if (selected.size > 40 * 1024 * 1024) {
			problem = '파일 크기는 40MB 이하여야 합니다.';
			return;
		}
		if (!selected.size) {
			problem = '빈 파일은 처리할 수 없습니다.';
			return;
		}
		file = selected;
	}
	async function upload(demo = false, basic = false) {
		if (step === 1 || (!demo && !file)) return;
		problem = '';
		result = null;
		canUseBasic = false;
		step = 1;
		progress = 0;
		stage = '파일을 올리는 중…';
		const form = new FormData();
		form.set('editor', editor);
		if (demo) form.set('demo', 'true');
		else form.set('file', file);
		if (basic) form.set('basic', 'true');
		try {
			const response = await fetch('/api/wikify', { method: 'POST', body: form });
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				throw new Error(
					payload?.message ||
						(response.status === 413
							? '업로드 서버의 파일 크기 제한을 초과했습니다. 작은 파일로 나누어 다시 올려 주세요.'
							: '업로드에 실패했습니다. 다시 시도해 주세요.')
				);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let doneResult = null;
			while (true) {
				const { value, done } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = JSON.parse(line);
					if (event.type === 'error') {
						canUseBasic = !!event.canUseBasic;
						throw new Error(event.message);
					}
					if (event.type === 'progress') {
						progress = event.progress;
						stage = event.stage;
					}
					if (event.type === 'done') doneResult = event;
				}
				if (done) break;
			}
			if (!doneResult)
				throw new Error('연결이 중단되었습니다. 초안 목록을 확인한 뒤 다시 시도해 주세요.');
			result = doneResult;
			progress = 100;
			step = 2;
			await invalidateAll();
		} catch (error) {
			problem = error.message || '연결에 실패했습니다. 다시 시도해 주세요.';
			step = 0;
		}
	}
</script>

<div class="modal-heading">
	<div>
		<h2>AI 위키파이어</h2>
		<p>기존 사내 문서를 올리면 위키 문서 초안으로 정리해 드립니다.</p>
	</div>
	{#if onclose}<button class="icon-button" onclick={onclose} aria-label="위키파이어 닫기">×</button
		>{/if}
</div>
<ol class="upload-steps" aria-label="초안 생성 단계">
	{#each ['1 · 올리기', '2 · 정리 중', '3 · 초안 확인'] as label, index}<li
			class:active={step >= index}
			aria-current={step === index ? 'step' : undefined}
		>
			{label}
		</li>{/each}
</ol>
{#if problem}<div class="notice warning" role="alert">
		{problem}{#if canUseBasic && file}<p style="margin-top:12px;font-size:13px">
				기본 초안은 원문을 보존하며 의미 기반 AI 검사를 생략합니다.
			</p>
			<button class="secondary-button" onclick={() => upload(false, true)}
				>원문으로 기본 초안 만들기</button
			>{/if}
	</div>{/if}
{#if step === 0}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="upload-zone"
		class:dragging
		ondragover={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={(event) => {
			event.preventDefault();
			dragging = false;
			selectFile(event.dataTransfer?.files[0]);
		}}
	>
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			><path d="M12 16V4m-5 5 5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg
		>
		<strong>파일을 끌어다 놓으세요</strong>
		<p>docx · pdf · pptx · 최대 40MB</p>
		<input
			id={`${uid}-file`}
			type="file"
			accept=".docx,.pdf,.pptx"
			onchange={(event) => {
				selectFile(event.currentTarget.files?.[0]);
				event.currentTarget.value = '';
			}}
			aria-label="위키로 변환할 파일"
		/>
		<div class="file-actions">
			<label for={`${uid}-file`} class="primary-button">파일 선택하기</label><button
				class="secondary-button"
				onclick={() => upload(true)}>공장약어집.pdf 예시로 시연</button
			>
		</div>
	</div>
	{#if file}<div class="file-selected">
			<span
				><strong>{file.name}</strong><br /><small>{(file.size / 1024 / 1024).toFixed(2)} MB</small
				></span
			><button class="icon-button" aria-label="선택한 파일 제거" onclick={() => (file = null)}
				>×</button
			>
		</div>{/if}
	<div class="field">
		<label for={`${uid}-editor`}>익명 편집자 이름</label><input
			id={`${uid}-editor`}
			bind:value={editor}
			placeholder="Operator-07"
		/>
	</div>
	<p class="muted" style="font-size:12px">
		AI 결과는 초안으로 저장되며 검토 후 게시합니다. 시연은 첨부 프로토타입의 예시 데이터를
		사용합니다. 스캔 파일의 이미지 인식은 지원하지 않습니다.
	</p>
	<div class="button-row">
		<button class="primary-button" disabled={!file} onclick={() => upload()}>초안 만들기 →</button>
	</div>
{:else if step === 1}
	<div class="upload-progress" role="status" aria-live="polite">
		<strong>{file?.name || '공장약어집.pdf 예시'} 정리 중…</strong><progress
			value={progress}
			max="100"
			aria-label="초안 생성 진행률">{progress}%</progress
		>
		<p>{stage} {progress}%</p>
		<small class="muted">완료될 때까지 창을 유지해 주세요.</small>
	</div>
{:else if result}
	<div class="notice">
		<strong>문서 초안 {result.drafts.length}건</strong>과
		<strong>문서 간 연결 {result.links}개</strong>를 만들었습니다. 게시 전에 확인해 주세요.
	</div>
	{#if result.mode === 'basic'}<p class="muted">
			AI 처리 없이 원문을 보존한 기본 초안입니다. 의미 기반 AI 검사는 생략되었으므로 게시 전에
			내용을 확인해 주세요.
		</p>{:else if result.mode === 'demo'}<p class="muted">
			프로토타입 예시 초안입니다. 실제 업무 문서와 구분해 검토해 주세요.
		</p>{/if}
	{#each result.drafts as draft}<a
			class="generated-item"
			href={`/drafts?open=${draft.id}`}
			onclick={() => onclose?.()}
			><div>
				<strong>{draft.title}</strong>
				<p>{draft.description}</p>
			</div>
			<span class="tag tag-green"
				>{draft.status === 'blocked' ? '검토 필요' : `연결 ${draft.links}`}</span
			></a
		>{/each}
	<div class="button-row" style="justify-content:flex-start;margin-top:20px">
		<a
			class="primary-button"
			href={`/drafts?open=${result.drafts[0].id}`}
			onclick={() => onclose?.()}>첫 초안 검토하기</a
		>{#if onclose}<button class="secondary-button" onclick={onclose}>나중에</button>{/if}<button
			class="secondary-button"
			onclick={() => {
				step = 0;
				file = null;
			}}>다른 파일 올리기</button
		>
	</div>
{/if}
