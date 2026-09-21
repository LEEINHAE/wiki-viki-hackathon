<script>
	import StatusNotice from './StatusNotice.svelte';
	import Icon from './Icon.svelte';
	import { documentHref } from '$lib/knowledge.js';
	let { query } = $props();
	let answer = $state(null);
	let loading = $state(true);
	let retry = $state(0);
	$effect(() => {
		const q = query;
		retry;
		const controller = new AbortController();
		answer = null;
		loading = true;
		async function load() {
			try {
				const response = await fetch('/api/answer', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ q }),
					signal: controller.signal
				});
				const value = await response.json();
				if (!controller.signal.aborted) answer = value;
			} catch {
				if (!controller.signal.aborted)
					answer = {
						status: 'unavailable',
						message: 'AI 설명을 불러오지 못했습니다. 아래 원문을 확인해 주세요.'
					};
			} finally {
				if (!controller.signal.aborted) loading = false;
			}
		}
		load();
		return () => controller.abort();
	});
</script>

<section class="answer-card" aria-label="AI 검색 설명" aria-busy={loading}>
	<div class="eyebrow">
		<Icon name="sparkles" size={17} /> 바로 읽히는 설명 <span class="tag">AI</span>
	</div>
	{#if loading}
		<h2>문서를 연결해 답을 찾고 있어요.</h2>
		<StatusNotice tone="pending"
			>검색된 사내 문서를 읽고, 출처와 함께 설명을 정리합니다.</StatusNotice
		>
		<div class="skeleton"></div>
		<div class="skeleton short"></div>
	{:else if answer?.status === 'complete'}
		<h2>{answer.title}</h2>
		{#each answer.paragraphs as paragraph}<p>
				{paragraph.text}
				<span class="citations"
					>{#each paragraph.sourceIds as id}<a
							href={documentHref(answer.sources.find((source) => source.id === id).slug)}
							aria-label={`출처 ${id}: ${answer.sources.find((source) => source.id === id).title}`}
							>[{id}]</a
						>{/each}</span
				>
			</p>{/each}
		<div class="source-links">
			{#each answer.sources as source}<a class="chip" href={documentHref(source.slug)}
					><span>{source.id}</span>{source.title} ↗</a
				>{/each}
		</div>
		<div class="answer-footer">
			<span
				>게시된 문서 {answer.sources.length}건을 바탕으로 생성한 설명입니다. 정확한 내용은 원문에서
				확인하세요.</span
			>
		</div>
	{:else}<h2>
			{answer?.status === 'blocked'
				? '콘텐츠 보호로 AI 설명이 차단됐습니다.'
				: '원문에서 답을 찾아보세요.'}
		</h2>
		<StatusNotice
			tone={answer?.status === 'unavailable'
				? 'error'
				: answer?.status === 'blocked'
					? 'warning'
					: 'info'}
		>
			<p>{answer?.message || 'AI 설명을 생성할 수 없습니다.'}</p>
			{#if answer?.status === 'unavailable'}<button
					class="secondary-button"
					onclick={() => (retry += 1)}>다시 시도</button
				>{/if}
		</StatusNotice>{/if}
</section>
