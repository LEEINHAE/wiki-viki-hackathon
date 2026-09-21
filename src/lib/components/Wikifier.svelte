<script>
	import ActorIdentity from './ActorIdentity.svelte';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	let { onclose = null } = $props();
	let step = $state(0);
	let file = $state(null);
	let fileInput = $state();
	let dragging = $state(false);
	let stage = $state('');
	let problem = $state('');
	let result = $state(null);
	let canUseBasic = $state(false);
	let editor = $state('Operator-07');
	const uid = $props.id();
	let jobId = $state('');
	let requestKey = '';
	let requestMode = '';
	let recovery = $state(null);
	let transfers = $state([]);
	onMount(() => {
		loadTransfers();
		try {
			jobId = localStorage.getItem('wiki-last-upload') || '';
		} catch {}
	});
	async function loadTransfers() {
		try {
			const response = await fetch('/api/uploads/chunks');
			if (response.ok) transfers = await response.json();
		} catch {
			/* The ordinary upload and job list remain usable. */
		}
	}
	async function discardTransfer(token) {
		try {
			const response = await fetch('/api/uploads/chunks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'discard', token })
			});
			const result = await response.json();
			if (!response.ok) throw Error(result.message);
			await loadTransfers();
		} catch (error) {
			problem = error.message || '임시 전송을 지우지 못했습니다.';
		}
	}
	async function transferFile(selected, signal) {
		stage = '파일을 확인하는 중…';
		const digest = await crypto.subtle.digest('SHA-256', await selected.arrayBuffer());
		const hash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('');
		const started = await fetch('/api/uploads/chunks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: selected.name, size: selected.size, hash }),
			signal
		});
		const transfer = await started.json();
		if (!started.ok) throw Error(transfer.message);
		let completed = transfer.received.length;
		for (let index = 0; index < transfer.parts; index++) {
			if (transfer.received.includes(index)) continue;
			stage = `파일 전송 ${completed}/${transfer.parts} 구간 완료`;
			const response = await fetch(`/api/uploads/chunks?token=${transfer.token}&part=${index}`, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: selected.slice(index * transfer.partBytes, (index + 1) * transfer.partBytes),
				signal
			});
			if (!response.ok) {
				const result = await response.json();
				throw Error(result.message);
			}
			completed++;
		}
		stage = `파일 전송 ${completed}/${transfer.parts} 구간 완료 · 초안 생성 준비 중…`;
		return transfer.token;
	}
	async function checkJob() {
		if (!jobId) return;
		try {
			const response = await fetch(`/api/uploads?job=${jobId}`);
			const jobs = await response.json();
			if (!response.ok) throw Error(jobs.message);
			recovery = jobs[0] || null;
			if (recovery?.state === 'completed') {
				result = recovery.result;
				step = 2;
			} else if (recovery)
				problem =
					recovery.message || `${recovery.stage} · 상태를 다시 확인하거나 작업 목록을 열어 주세요.`;
			else
				problem =
					'현재 계정 또는 브라우저에서 이 작업을 찾을 수 없습니다. 초안 목록을 확인해 주세요.';
		} catch {
			problem = '작업 상태를 확인하지 못했습니다. 작업 목록에서 다시 확인해 주세요.';
		}
	}
	function rememberJob(id) {
		jobId = String(id);
		try {
			localStorage.setItem('wiki-last-upload', jobId);
		} catch {}
	}
	function selectFile(selected) {
		problem = '';
		if (!selected) return;
		file = null;
		requestKey = '';
		requestMode = '';
		if (!/\.(docx|pdf|xlsx|pptx)$/i.test(selected.name)) {
			problem = 'DOCX, PDF, XLSX, PPTX 파일만 지원합니다.';
			return;
		}
		if (selected.size > 10 * 1024 * 1024) {
			problem = '파일 크기는 10MB 이하여야 합니다.';
			return;
		}
		if (!selected.size) {
			problem = '빈 파일은 처리할 수 없습니다.';
			return;
		}
		file = selected;
	}
	async function upload(demo = false, basic = false, retry = false) {
		if (step === 1 || (!demo && !file)) return;
		problem = '';
		result = null;
		canUseBasic = false;
		step = 1;
		stage = '파일을 올리는 중…';
		const form = new FormData();
		form.set('editor', editor);
		const mode = demo ? 'demo' : basic ? 'basic' : 'ai';
		if (!requestKey || requestMode !== mode) {
			requestKey = crypto.randomUUID();
			requestMode = mode;
		}
		form.set('requestKey', requestKey);
		if (retry) form.set('retry', 'true');
		if (demo) form.set('demo', 'true');
		if (basic) form.set('basic', 'true');
		const controller = new AbortController();
		let timer = setTimeout(() => controller.abort(), 120000);
		let generating = false;
		try {
			if (!demo) {
				if (file.size > 3 * 1024 * 1024)
					form.set('uploadToken', await transferFile(file, controller.signal));
				else form.set('file', file);
			}
			clearTimeout(timer);
			timer = setTimeout(() => controller.abort(), 120000);
			generating = true;
			const response = await fetch('/api/wikify', {
				method: 'POST',
				body: form,
				signal: controller.signal
			});
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
					if (event.jobId) rememberJob(event.jobId);
					if (event.type === 'pending') {
						recovery = event;
						throw new Error(
							event.state === 'failed'
								? '이미 실패한 작업이 있습니다. 같은 파일로 재시도하거나 작업 내용을 확인해 주세요.'
								: event.message || '같은 파일의 작업이 이미 있습니다. 작업 상태를 확인해 주세요.'
						);
					}
					if (event.type === 'error') {
						canUseBasic = !!event.canUseBasic;
						throw new Error(event.message);
					}
					if (event.type === 'progress') {
						stage = event.stage;
					}
					if (event.type === 'done') doneResult = event;
				}
				if (done) break;
			}
			if (!doneResult)
				throw new Error('연결이 중단되었습니다. 초안 목록을 확인한 뒤 다시 시도해 주세요.');
			result = doneResult;
			step = 2;
			await invalidateAll();
		} catch (error) {
			problem =
				error.name === 'AbortError'
					? generating
						? '초안 처리에 120초가 지났습니다. 서버 처리는 계속될 수 있으므로 먼저 작업 상태를 확인해 주세요.'
						: '파일 전송에 120초가 지났습니다. 30분 안에 같은 파일을 선택하면 남은 구간을 이어서 전송합니다.'
					: error.message || '연결에 실패했습니다. 다시 시도해 주세요.';
			step = 0;
		} finally {
			clearTimeout(timer);
			loadTransfers();
		}
	}
</script>

<div class="modal-heading">
	<div>
		<h2>AI 위키파이어</h2>
		<p>파일 하나를 용어·개념·업무 절차별 여러 위키 문서 초안으로 나눕니다.</p>
	</div>
	{#if onclose}<button class="icon-button" onclick={onclose} aria-label="위키파이어 닫기">×</button
		>{/if}
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable panel supports keyboard PageDown and End.) -->
<div class="wikifier-body" role="region" aria-label="파일 전환 작업" tabindex="0">
	<ol class="upload-steps" aria-label="초안 생성 단계">
		{#each ['1 · 올리기', '2 · 정리 중', '3 · 초안 확인'] as label, index}<li
				class:active={step >= index}
				aria-current={step === index ? 'step' : undefined}
			>
				{label}
			</li>{/each}
	</ol>
	{#if result?.reused}<p class="notice">
			같은 파일에서 이미 생성한 초안입니다. 기존 작업을 다시 열었습니다.
		</p>{/if}
	{#if problem}<div class="notice warning" role="alert">
			{problem}{#if canUseBasic && file}<p style="margin-top:12px;font-size:13px">
					기본 초안은 원문을 보존하며 의미 기반 AI 검사를 생략합니다.
				</p>
				<button class="secondary-button" onclick={() => upload(false, true)}
					>원문으로 기본 초안 만들기</button
				>{/if}
		</div>{/if}
	{#if jobId}<div class="notice">
			<strong>업로드 작업 #{jobId}</strong>
			<div class="button-row">
				<button class="secondary-button" type="button" onclick={checkJob}
					>작업 상태 다시 확인</button
				><a href={`/uploads?open=${jobId}`} onclick={onclose || undefined}>작업 기록 열기</a>
			</div>
			{#if file && recovery && (recovery.state === 'failed' || recovery.expired)}<button
					type="button"
					class="secondary-button"
					onclick={() => upload(false, canUseBasic || recovery.mode === 'basic', true)}
					>같은 파일로 실패·중단 작업 재시도</button
				>{/if}
		</div>{/if}
	{#if step === 0}
		{#if page.data.contentPolicy === 'relaxed'}<p class="notice">
				개발용 완화 검사: 이름·직함·연락처·일반 사내 정보가 있어도 초안을 만듭니다. 명백한 인증
				정보·주민등록번호는 차단하며, AI 의미 검사는 생략합니다.
			</p>{/if}
		<p class="muted">
			의미에 따라 최대 8개로 나눕니다. 하나의 주제만 담긴 파일은 초안 1개로 정리합니다.
		</p>
		{#if !page.data.aiAvailable}<p class="notice warning" role="status">
				현재 AI가 연결되지 않아 의미별 분리를 사용할 수 없습니다. 원문을 담은 기본 초안 1개만 만들
				수 있습니다.
			</p>{/if}
		{#if transfers.length}<details class="notice">
				<summary>아직 끝나지 않은 파일 전송 {transfers.length}건</summary>
				<p>
					같은 파일을 다시 선택하면 남은 구간을 이어서 보냅니다. 전송을 지워도 기존 초안·작업 기록은
					유지됩니다.
				</p>
				{#each transfers as transfer}<div class="button-row">
						<span>{transfer.name} · {transfer.received.length}/{transfer.parts} 구간</span><button
							class="secondary-button"
							type="button"
							onclick={() => discardTransfer(transfer.token)}>이 임시 전송 지우기</button
						>
					</div>{/each}
			</details>{/if}
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
			<p>docx · pdf · xlsx · pptx · 최대 10MB</p>
			<input
				id={`${uid}-file`}
				type="file"
				bind:this={fileInput}
				tabindex="-1"
				accept=".docx,.pdf,.xlsx,.pptx"
				onchange={(event) => {
					selectFile(event.currentTarget.files?.[0]);
					event.currentTarget.value = '';
				}}
				aria-label="위키로 변환할 파일"
			/>
			<div class="file-actions">
				<button type="button" class="primary-button" onclick={() => fileInput?.click()}
					>파일 선택하기</button
				><button class="secondary-button" onclick={() => upload(true)}
					>공장약어집.pdf 예시로 시연</button
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
		<ActorIdentity id={`${uid}-editor`} label="편집자" bind:value={editor} />
		<p class="muted" style="font-size:12px">
			AI 결과는 초안으로 저장되며 검토 후 게시합니다. 추출 원문과 파일명은 대조용으로 서버에
			보관합니다. 큰 파일은 구간별로 임시 전송하며 결합 후 제거합니다. 미완료 전송은 30분 뒤
			만료되고 다음 전송 요청 때 삭제됩니다. 원본 파일을 영구 보관하지 않습니다. 시연은 예시
			데이터를 사용합니다. 스캔 이미지 인식은 지원하지 않습니다.
		</p>
		<div class="button-row">
			<button
				class="primary-button"
				disabled={!file}
				onclick={() => upload(false, !page.data.aiAvailable)}
				>{page.data.aiAvailable ? '의미별 초안 만들기 →' : '원문으로 기본 초안 만들기 →'}</button
			>
		</div>
	{:else if step === 1}
		<div class="upload-progress" role="status" aria-live="polite">
			<strong>{file?.name || '공장약어집.pdf 예시'} 정리 중…</strong><progress
				aria-label="초안 처리 중"
			></progress>
			<p>{stage}</p>
			<small class="muted">완료될 때까지 창을 유지해 주세요.</small>
		</div>
	{:else if result}
		<div class="notice">
			<strong>문서 초안 {result.drafts.length}건</strong>과
			<strong>문서 간 연결 {result.links}개</strong>를 만들었습니다. 게시 전에 확인해 주세요.
		</div>
		{#if result.mode === 'basic'}<p class="muted">
				AI 처리 없이 원문을 보존한 기본 초안입니다. 의미별 분리와 의미 기반 AI 검사를 생략했습니다.
				{#if page.data.aiAvailable}여러 문서로 나누려면 같은 파일을 다시 선택해 의미별 초안을 만들어
					주세요.{/if}
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
</div>
