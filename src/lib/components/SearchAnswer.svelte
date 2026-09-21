<script>
	import { onDestroy } from 'svelte';
	let { options, count = 0 } = $props();
	let state = $state('idle');
	let answer = $state(null);
	let message = $state('');
	let controller;
	const key = $derived(
		JSON.stringify({
			q: options.q,
			field: options.field,
			tag: options.tag,
			state: options.state,
			days: options.days,
			sort: options.sort
		})
	);
	$effect(() => {
		key;
		controller?.abort();
		state = 'idle';
		answer = null;
		message = '';
	});
	onDestroy(() => controller?.abort());
	async function generate() {
		controller?.abort();
		const active = new AbortController();
		controller = active;
		state = 'loading';
		message = '';
		answer = null;
		try {
			const res = await fetch('/api/answer', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: key,
				signal: active.signal
			});
			const value = await res.json();
			if (active.signal.aborted) return;
			state = value.state;
			message = value.message || '';
			answer = value;
		} catch {
			if (!active.signal.aborted) {
				state = 'error';
				message = '연결이 끊어졌습니다. 검색 결과를 확인하거나 다시 시도해 주세요.';
			}
		}
	}
	function cancel() {
		controller?.abort();
		state = 'cancelled';
		message =
			'설명 요청을 취소했습니다. 서버에도 취소를 전달했으며 이미 처리된 요청의 사용량은 발생할 수 있습니다.';
	}
	const number = (id) => 1 + (answer?.sources || []).findIndex((s) => s.id === id);
</script>

<section class="answer-card" aria-label="AI 검색 설명" aria-busy={state === 'loading'}>
	<span class="overline">AI 설명 · 게시 문서 기반</span>
	{#if state === 'idle'}
		<p>상위 문서 최대 6개를 바탕으로 설명과 근거 문단을 생성합니다.</p>
		<button class="primary-button" disabled={!count} onclick={generate}
			>문서로 AI 설명 만들기</button
		>
	{:else if state === 'loading'}
		<p role="status">
			문서의 근거를 확인하며 설명을 만들고 있습니다. 아래 검색 결과는 바로 읽을 수 있습니다.
		</p>
		<button class="secondary-button" onclick={cancel}>요청 취소</button>
	{:else if state === 'ready'}
		{#each answer.paragraphs as paragraph}<p>
				{paragraph.text}
				{#each paragraph.sources as id}<a
						class="citation"
						href={`#source-${id}`}
						aria-label={`출처 ${number(id)} 확인`}>[{number(id)}]</a
					>{/each}
			</p>{/each}
		{#if answer.conflicts.length}<div class="notice warning">
				<strong>원문 사이에 차이가 있습니다</strong>{#each answer.conflicts as conflict}<p>
						{conflict.text}
						{#each conflict.sources as id}<a href={`#source-${id}`}>[{number(id)}]</a>{/each}
					</p>{/each}
			</div>{/if}
		<details>
			<summary>근거 문단과 리비전 {answer.sources.length}개</summary>
			<ol class="answer-sources">
				{#each answer.sources as source}<li id={`source-${source.id}`}>
						<a href={source.url}
							>{source.title} · {source.section || '본문'} · 리비전 {source.revisionId}</a
						>
						<blockquote>{source.excerpt}</blockquote>
					</li>{/each}
			</ol>
		</details>
		<small>AI가 해석한 설명입니다. 출처 연결은 사실 검증이나 검토 완료를 뜻하지 않습니다.</small>
	{:else}
		<p class="notice warning" role="status">{message}</p>
		<button class="secondary-button" onclick={generate}>다시 시도</button>
	{/if}
</section>
