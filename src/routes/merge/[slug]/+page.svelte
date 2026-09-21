<script>
	import { enhance } from '$app/forms';
	import { enhanceSave } from '$lib/enhance-save.js';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import FormRecovery from '$lib/components/FormRecovery.svelte';
	import { roleLabels, roles } from '$lib/auth-policy.js';
	let { data, form } = $props();
	let content = $state('');
	let element = $state();
	$effect(() => {
		content =
			form?.content ??
			(data.target ? `${data.target.content}\n\n---\n\n${data.source.content}` : '');
	});
</script>

<svelte:head><title>문서 병합 검토 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>{data.source.title} · 게시 문서 병합</h1>
	<p>
		원본 본문과 이력은 각 문서에 남습니다. 병합 후 원본 주소는 대상 문서를 열며, 기존 역사와 토론은
		원본 문서에서 계속 확인할 수 있습니다.
	</p>
	{#if form?.message}<p class="notice warning" role="alert">{form.message}</p>{/if}
	{#if data.source.wv_merged_into}<p class="notice">
			이미 병합된 원본 문서입니다. <a href={`/wiki/${encodeURIComponent(data.source.slug)}`}
				>병합된 문서 열기</a
			>
		</p>{:else}
		<form method="GET" class="form-row">
			<label>병합 대상 제목 또는 별칭<input name="target" required value={data.targetName} /></label
			><button class="secondary-button">두 문서 비교</button>
		</form>
		{#if data.target}
			<section class="card">
				<h2>병합 전 원문</h2>
				<details>
					<summary>원본: {data.source.title}</summary>
					<div class="wiki-content">{@html data.sourceHtml}</div>
				</details>
				<details>
					<summary>대상: {data.target.title}</summary>
					<div class="wiki-content">{@html data.targetHtml}</div>
				</details>
			</section>
			<section class="card">
				<h2>{data.target.title}에 저장할 최종 본문</h2>
				<p>
					아래 본문을 직접 정리해 중복과 상충을 해결해 주세요. 대상의 제목·분야·담당자를 유지하고 두
					문서의 원문 출처를 함께 보존합니다.
				</p>
				<p class="notice">
					병합 후 읽기 권한: {roleLabels[
						roles[
							Math.max(
								roles.indexOf(data.source.wv_min_role),
								roles.indexOf(data.target.wv_min_role)
							)
						]
					]} 이상. 본문과 함께 기록된 태그·읽기 권한을 확인해 주세요.
				</p>
				<form method="POST" bind:this={element} use:enhance={enhanceSave}>
					<FormRecovery
						{element}
						storageKey={`document-merge:${data.source.id}:${data.target.id}`}
						kind="document_merge"
						resources={[
							{ type: 'document', id: data.source.id },
							{ type: 'document', id: data.target.id }
						]}
					/>
					<input
						type="hidden"
						name="sourceVersion"
						value={form?.sourceVersion ?? data.source.version}
					/><input
						type="hidden"
						name="targetVersion"
						value={form?.targetVersion ?? data.target.version}
					/><input type="hidden" name="targetSlug" value={data.target.slug} />
					<MarkdownEditor bind:value={content} name="content" original={data.target.content} />
					<label
						>최종 태그<input
							name="tags"
							value={form?.tags ?? data.tags.join(', ')}
							placeholder="쉼표로 구분 · 최대 20개"
						/></label
					>
					<label
						>병합 이유<textarea name="note" rows="3" maxlength="2000">{form?.note || ''}</textarea
						></label
					>
					<label
						><input type="checkbox" name="reviewed" value="yes" required /> 두 원문과 최종 본문을 검토했으며
						원본 주소를 대상 문서로 연결합니다.</label
					>
					<button class="primary-button">검토한 본문으로 병합</button>
				</form>
			</section>
		{/if}{/if}
</main>
