<script>let { data, form } = $props(); const title = $derived(form?.title ?? data.document?.title ?? decodeURIComponent(data.slug).replaceAll('-', ' '));</script>
<svelte:head><title>{title} 편집 — Wiki Viki</title></svelte:head>
<div class="form-page"><form class="wiki-form" method="POST" action="?/save"><h1>{data.document ? '문서 편집' : '문서 만들기'}: {title}</h1>
	{#if data.databaseError}<div class="notice warning">{data.databaseError}</div>{/if}{#if form?.message}<div class="notice warning">{form.message}</div>{/if}
	<div class="field"><label for="title">문서 제목</label><input id="title" name="title" value={title} required /></div>
	<div class="field"><label for="content">위키 본문</label><textarea id="content" name="content" required>{form?.content ?? data.document?.content ?? '# 개요\n\n이곳에 문서 내용을 작성하세요. [[문서 이름]] 형식으로 다른 문서를 연결할 수 있습니다.'}</textarea><small>Markdown, <code>[[위키 링크]]</code>, 각주, 표, 인용문, 코드, ~~취소선~~을 지원합니다.</small></div>
	<div class="field"><label for="aliases">넘겨주기 별칭</label><input id="aliases" name="aliases" value={form?.aliases ?? data.aliases ?? ''} placeholder="블로다운, 블로 다운, Blowdown" /><small>쉼표로 구분한 별칭을 입력하면 이 대표 문서로 연결됩니다.</small></div>
	<div class="form-row"><div class="field"><label for="editor">익명 편집자 이름</label><input id="editor" name="editor" value={form?.editor ?? 'Editor-01'} required /></div><div class="field"><label for="summary">편집 요약</label><input id="summary" name="summary" value={form?.summary ?? ''} placeholder="무엇을 변경했나요?" /></div></div>
	<div class="button-row"><a class="secondary-button" href={data.document ? `/wiki/${data.document.slug}` : '/'}>취소</a><button class="primary-button">문서 저장</button></div>
</form>{#if data.document}<form class="wiki-form" method="POST" action="?/delete" onsubmit={(event) => { if (!confirm(`${data.document.title} 문서를 삭제할까요? 문서 역사, 토론, 넘겨주기도 함께 삭제됩니다.`)) event.preventDefault(); }}><div class="button-row"><button class="danger-button">문서 삭제</button></div></form>{/if}</div>
