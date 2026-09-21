<script>
	let { data, form } = $props();
</script>

<svelte:head><title>휴지통 — 위키비키</title></svelte:head>
<main class="form-page">
	<section class="wiki-form">
		<header class="document-header">
			<h1>휴지통</h1>
			<p>문서와 별칭·리비전·토론을 함께 보존합니다. 복구하면 기존 주소로 다시 읽을 수 있습니다.</p>
		</header>
		{#if form?.message || data.databaseError}<p class="notice warning" role="alert">
				{form?.message || data.databaseError}
			</p>{/if}
		{#each data.documents as doc}<form method="POST" action="?/restore" class="draft-row">
				<div>
					<h2>{doc.title}</h2>
					<small>{new Date(doc.deleted_at).toLocaleString('ko-KR')} · {doc.deleted_by}</small>
				</div>
				<input type="hidden" name="id" value={doc.id} /><input
					type="hidden"
					name="version"
					value={doc.version}
				/>
				<label
					>익명 편집자 <input
						name="editor"
						value="Editor-01"
						required
						aria-label={`${doc.title} 복구 편집자`}
					/></label
				>
				<button class="secondary-button">복구</button>
			</form>{:else}{#if !data.databaseError}<p class="empty-state">
					휴지통이 비어 있습니다.
				</p>{/if}{/each}
	</section>
</main>
