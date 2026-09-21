<script>
	let uploading = $state(false);
	let result = $state(null);
	let problem = $state('');
	async function submit(event) {
		event.preventDefault();
		uploading = true;
		problem = '';
		result = null;
		const response = await fetch('/api/wikify', {
			method: 'POST',
			body: new FormData(event.currentTarget)
		});
		const payload = await response.json();
		uploading = false;
		if (!response.ok) problem = payload.message;
		else result = payload;
	}
</script>

<svelte:head><title>AI 위키 변환 — Wiki Viki</title></svelte:head>
<div class="form-page">
	<section class="wiki-form">
		<header class="document-header">
			<h1>AI 위키 변환</h1>
			<div class="document-meta">파일 업로드 → 내용 추출 → AI 구조화 → 콘텐츠 보호 검사 → 초안 생성</div>
		</header>
		<div class="notice">
			<strong>담당자 검토는 필수입니다.</strong> AI 결과는 초안으로 저장되며 자동으로 게시되지 않습니다.
		</div>
		<form onsubmit={submit}>
			<div class="upload-zone">
				<p><b>DOCX 또는 텍스트 기반 PDF 파일을 선택하세요</b></p>
				<input
					name="file"
					type="file"
					accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
					required
				/>
				<p class="muted">OCR 및 스캔 PDF는 지원하지 않습니다. 최대 파일 크기는 10MB입니다.</p>
			</div>
			<div class="field">
				<label for="editor">익명 담당자 이름</label><input
					id="editor"
					name="editor"
					value="Editor-01"
					required
				/>
			</div>
			<div class="button-row">
				<button class="primary-button" disabled={uploading}
					>{uploading ? '초안 만드는 중…' : '초안 만들기'}</button
				>
			</div>
		</form>
		{#if problem}<div class="notice warning">{problem}</div>{/if}{#if result}<div class="notice">
				<b>초안을 만들었습니다:</b>
				{result.title}. <a href={`/drafts?open=${result.id}`}>초안 검토하기 →</a>
			</div>{/if}
	</section>
</div>
