<script>let { data, form } = $props();</script>
<div class="form-page"><section class="wiki-form"><header class="document-header"><h1>문서 역사: {data.document.title}</h1><div class="document-meta">이 문서에 저장된 모든 버전을 확인할 수 있습니다.</div></header>
	<nav class="document-actions"><a href={`/wiki/${data.document.slug}`}>읽기</a><a href={`/edit/${data.document.slug}`}>편집</a><a href={`/discussion/${data.document.slug}`}>토론</a></nav>{#if form?.message}<div class="notice warning">{form.message}</div>{/if}
	{#if data.selected}<h2>리비전 {data.selected} 변경 사항</h2><div class="diff-box">{#each data.changes as part}<span class:diff-add={part.added} class:diff-remove={part.removed}>{part.value}</span>{/each}</div>{/if}
	<ul class="history-list">{#each data.revisions as revision}<li><time>{new Date(revision.created_at).toLocaleString('ko-KR')}</time><b>{revision.editor_handle}</b><span>{revision.summary || '요약 없음'}</span><span><a href={`?diff=${revision.id}`}>차이 보기</a> · <form method="POST" action="?/rollback" style="display:inline"><input type="hidden" name="revision" value={revision.id} /><button class="danger-button">이 버전으로 되돌리기</button></form></span></li>{/each}</ul>
</section></div>
