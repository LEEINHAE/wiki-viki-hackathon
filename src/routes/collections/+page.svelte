<script>
	import { enhance } from '$app/forms';
	import { enhanceSave } from '$lib/enhance-save.js';
	let { data, form } = $props();
</script>

<svelte:head><title>문서 묶음 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>문서 묶음</h1>
	<p>
		업무에 필요한 문서를 읽을 순서대로 모읍니다. 공유해도 각 문서의 읽기 권한은 그대로 적용됩니다.
	</p>
	<div class="button-row">
		<a href="/collections">새 묶음 만들기</a><a href="/library">내 문서</a>
	</div>
	{#if form?.message}<p class="notice" role="alert">{form.message}</p>{/if}
	{#if data.selected}
		<section class="card">
			<h2>{data.selected.title}</h2>
			<p>{data.selected.description}</p>
			<p class="muted">
				{data.selected.owner} · {data.selected.shared ? '구성원에게 공유' : '나만 보기'}
			</p>
			<ol>
				{#each data.items as item}<li>
						<a href={`/wiki/${encodeURIComponent(item.slug)}`}>{item.title}</a
						>{#if item.description}<p>{item.description}</p>{/if}
					</li>{:else}<li>현재 읽을 수 있는 문서가 없습니다.</li>{/each}
			</ol>
		</section>
	{/if}
	{#if !data.selected || data.own}
		<section class="card">
			<h2>{data.selected ? '묶음 수정' : '새 묶음'}</h2>
			<form method="POST" action="?/save" use:enhance={enhanceSave}>
				<input type="hidden" name="id" value={data.selected?.id || ''} /><input
					type="hidden"
					name="version"
					value={data.selected?.version || ''}
				/>
				<label
					>제목<input
						name="title"
						required
						maxlength="200"
						value={form?.title ?? data.selected?.title ?? ''}
					/></label
				>
				<label
					>설명<textarea name="description" maxlength="2000" rows="3"
						>{form?.description ?? data.selected?.description ?? ''}</textarea
					></label
				>
				<label
					>문서 순서<textarea
						name="documents"
						rows="8"
						placeholder="문서 제목 또는 위키 주소를 한 줄에 하나씩 입력"
						aria-describedby="collection-order-help"
						>{form?.documents ?? data.items.map((i) => i.title).join('\n')}</textarea
					></label
				>
				<p id="collection-order-help" class="muted">
					최대 100개. 줄 순서대로 표시하며 같은 문서는 한 번만 포함합니다. 줄을 지우면 묶음에서
					제외됩니다.
				</p>
				<label class="checkbox-label"
					><input
						type="checkbox"
						name="shared"
						value="yes"
						checked={form ? form.shared === 'yes' : data.selected?.shared || false}
					/> 구성원에게 제목·설명과 문서 목록 공유</label
				>
				{#if data.unavailable}<p class="notice">
						읽을 수 없거나 보관·삭제된 문서 {data.unavailable}개가 이 묶음에 남아 있습니다. 아래
						확인 없이 저장하면 기존 목록을 유지합니다.
					</p>
					<label class="checkbox-label"
						><input type="checkbox" name="dropUnavailable" value="yes" /> 표시되지 않는 문서를 묶음에서
						제외하고 저장</label
					>{/if}
				<button class="primary-button">묶음 저장</button>
			</form>
		</section>
	{/if}
	<section class="card">
		<h2>내 묶음과 공유된 묶음</h2>
		{#each data.rows as row}<article class="search-result">
				<h3><a href={`?open=${row.id}&page=${data.page}`}>{row.title}</a></h3>
				<p>{row.description}</p>
				<p class="muted">{row.owner} · {row.shared ? '공유' : '나만 보기'}</p>
			</article>{:else}<p>아직 등록된 문서 묶음이 없습니다.</p>{/each}
		<nav class="pagination" aria-label="문서 묶음 페이지">
			{#if data.page > 1}<a href={`?page=${data.page - 1}`}>이전</a>{/if}<span
				>{data.page}페이지</span
			>{#if data.page * 20 < data.total}<a href={`?page=${data.page + 1}`}>다음</a>{/if}
		</nav>
	</section>
</main>
