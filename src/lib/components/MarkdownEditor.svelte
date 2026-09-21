<script>
	import { tick } from 'svelte';
	import { diffLines } from 'diff';
	import { templates, insertMarkup } from '$lib/editor-tools.js';
	import { headingSourceRange } from '$lib/wiki-renderer.js';
	import { renderWikiHtml } from '$lib/wiki-renderer.js';
	let {
		value = $bindable(''),
		name = 'content',
		id = 'content',
		original = '',
		focusHeading = '',
		focusRange = null
	} = $props();
	let preview = $state('');
	let error = $state('');
	let tab = $state('edit');
	let loading = $state(false);
	let textarea = $state();
	let sectionFocused = $state(false);
	let compare = $state(false);
	let template = $state('term');
	let query = $state('');
	let suggestions = $state([]);
	let chosen = $state(0);
	let suggestionStart = 0;
	const differences = $derived(compare ? diffLines(original, value, { timeout: 200 }) : []);
	$effect(() => {
		const range = focusRange;
		if (range && textarea) {
			tab = 'edit';
			tick().then(() => {
				textarea.focus();
				textarea.setSelectionRange(range.start, range.end);
			});
		}
	});

	function context() {
		const before = value.slice(0, textarea?.selectionStart || 0);
		const match = before.match(/\[\[([^\]\n|]{1,80})$/);
		query = match?.[1] || '';
		suggestionStart = match ? before.lastIndexOf('[[') : 0;
		chosen = 0;
	}
	async function insert(before, after = '', placeholder = '내용') {
		const result = insertMarkup(
			value,
			textarea.selectionStart,
			textarea.selectionEnd,
			before,
			after,
			placeholder
		);
		value = result.value;
		await tick();
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		textarea.focus();
		textarea.setSelectionRange(result.start, result.end);
		context();
	}
	async function choose(doc) {
		const cursor = suggestionStart + doc.title.length + 4;
		const end = textarea.selectionStart;
		value =
			value.slice(0, suggestionStart) + `[[${doc.title}]]` + value.slice(end).replace(/^\]\]/, '');
		query = '';
		await tick();
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		textarea.focus();
		textarea.setSelectionRange(cursor, cursor);
	}
	async function applyTemplate() {
		value += (value.trim() ? '\n\n' : '') + templates[template];
		await tick();
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
	}

	function keys(event) {
		if (!suggestions.length || !query) return;
		if (event.key === 'Escape') {
			query = '';
			event.preventDefault();
		}
		if (event.key === 'ArrowDown') {
			chosen = (chosen + 1) % suggestions.length;
			event.preventDefault();
		}
		if (event.key === 'ArrowUp') {
			chosen = (chosen + suggestions.length - 1) % suggestions.length;
			event.preventDefault();
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			choose(suggestions[chosen]);
		}
	}
	$effect(() => {
		const q = query;
		suggestions = [];
		if (!q) return;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
					signal: controller.signal
				});
				if (res.ok && !controller.signal.aborted) suggestions = await res.json();
			} catch {}
		}, 200);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
	$effect(() => {
		if (sectionFocused || !focusHeading || !textarea || !value) return;
		const range = headingSourceRange(value, focusHeading);
		if (!range) return;
		sectionFocused = true;
		textarea.focus();
		textarea.setSelectionRange(range.start, range.end);
		textarea.scrollIntoView({ block: 'center' });
	});

	$effect(() => {
		const current = value;
		preview = renderWikiHtml(current);
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			loading = true;
			error = '';
			try {
				const response = await fetch('/api/preview', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ content: current }),
					signal: controller.signal
				});
				const result = await response.json();
				if (!response.ok) throw new Error(result.message);
				if (!controller.signal.aborted) preview = result.html;
			} catch (cause) {
				if (!controller.signal.aborted) error = cause.message;
			} finally {
				if (!controller.signal.aborted) loading = false;
			}
		}, 200);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
</script>

<div class="editor-toolbar" aria-label="본문 삽입 도구">
	<button type="button" class="secondary-button" onclick={() => insert('## ', '', '제목')}
		>제목</button
	><button type="button" class="secondary-button" onclick={() => insert('- ')}>목록</button><button
		type="button"
		class="secondary-button"
		onclick={() => insert('> ')}>인용</button
	><button type="button" class="secondary-button" onclick={() => insert('[[', ']]', '문서 이름')}
		>위키 링크</button
	><button
		type="button"
		class="secondary-button"
		onclick={() => insert('\n| 항목 | 내용 |\n| --- | --- |\n| ', ' | 값 |\n', '항목')}>표</button
	>
	<label
		>문서 틀 <select bind:value={template}
			><option value="term">용어</option><option value="procedure">업무 절차</option><option
				value="faq">FAQ</option
			></select
		></label
	><button type="button" class="secondary-button" onclick={applyTemplate}>틀 덧붙이기</button>
	<button
		type="button"
		class="secondary-button"
		aria-pressed={compare}
		onclick={() => (compare = !compare)}>{compare ? '변경 비교 닫기' : '저장 전 변경 비교'}</button
	>
</div>
{#if sectionFocused}<p class="notice">
		선택한 문단으로 이동했습니다. 전체 문서의 버전을 검사한 뒤 저장합니다.
	</p>{/if}
{#if compare}<section aria-label="저장 전 본문 변경 비교">
		<p>추가(올리브) · 삭제(취소선)</p>
		<div class="diff-box">
			{#if differences}{#each differences as part}<span
						class:diff-add={part.added}
						class:diff-remove={part.removed}>{part.value}</span
					>{/each}{:else}변경이 커서 비교 시간을 넘었습니다. 원문과 입력을 직접 확인해 주세요.{/if}
		</div>
	</section>{/if}
<div class="preview-tabs editor-tabs" aria-label="편집 보기">
	<button
		type="button"
		class="secondary-button"
		aria-pressed={tab === 'edit'}
		onclick={() => (tab = 'edit')}>편집</button
	>
	<button
		type="button"
		class="secondary-button"
		aria-pressed={tab === 'preview'}
		onclick={() => (tab = 'preview')}>미리보기</button
	>
</div>
<div class="editor-grid" class:preview-selected={tab === 'preview'}>
	<div class="editor-input">
		<label for={id}>위키 본문</label><textarea
			{id}
			{name}
			bind:this={textarea}
			bind:value
			oninput={context}
			onkeydown={keys}
			onclick={context}
			required
			maxlength="200000"></textarea>
		{#if query && suggestions.length}<div class="editor-suggestions" aria-label="위키 링크 제안">
				<p class="muted">위·아래 키로 선택, Enter로 삽입, Escape로 닫기</p>
				{#each suggestions as doc, index}<button
						type="button"
						class="secondary-button"
						class:active={index === chosen}
						onclick={() => choose(doc)}>{doc.title}</button
					>{/each}
			</div>{/if}
	</div>
	<section class="editor-preview" aria-label="현재 입력 미리보기">
		<small>{loading ? '링크 확인 중…' : '현재 입력 미리보기 · 아직 저장되지 않았습니다.'}</small>
		{#if error}<p class="notice warning" role="status">
				{error} 링크 존재 여부는 확인 전입니다.
			</p>{/if}
		<div class="wiki-content">{@html preview}</div>
	</section>
</div>
