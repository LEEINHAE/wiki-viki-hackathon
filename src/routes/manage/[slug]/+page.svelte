<script>
	import { roles, roleLabels } from '$lib/auth-policy.js';
	let { data, form } = $props();
</script>

<svelte:head><title>{data.document.title} 관리 — 위키비키</title></svelte:head>
<main class="page-shell">
	<a href={`/wiki/${encodeURIComponent(data.document.slug)}`}>← 문서 읽기</a>
	<h1>{data.document.title} · 검토와 관리</h1>
	{#if form?.message}<p class="notice warning" role="alert">{form.message}</p>{/if}
	<section class="card">
		<h2>이름 변경과 문서 병합</h2>
		<p>
			이름을 바꿔도 기존 대표 주소와 별칭은 유지됩니다. 새 제목으로도 이 문서를 찾을 수 있습니다.
		</p>
		<form method="POST">
			<input type="hidden" name="version" value={data.document.version} /><input
				type="hidden"
				name="action"
				value="rename"
			/>
			<label
				>새 제목<input
					name="title"
					required
					maxlength="200"
					value={form?.action === 'rename' ? form.title : data.document.title}
				/></label
			>
			<label
				><input type="checkbox" name="reviewed" value="yes" required /> 기존 주소를 유지하고 문서 이름을
				변경합니다.</label
			>
			<button class="secondary-button">이름 변경</button>
		</form>
		<p>
			<a href={`/merge/${encodeURIComponent(data.document.slug)}`}>다른 게시 문서와 병합 검토</a>
		</p>
	</section>
	<section class="card">
		<h2>담당자와 정기 검토</h2>
		<form method="POST">
			<input type="hidden" name="version" value={data.document.version} />
			<div class="form-row">
				<label
					>담당자<select name="ownerId" value={data.document.wv_owner_id || ''}
						><option value="">미지정</option>{#each data.owners as owner}<option value={owner.id}
								>{owner.handle}</option
							>{/each}</select
					></label
				><label
					>다음 검토일<input
						type="date"
						name="nextReviewOn"
						value={data.document.wv_next_review_on?.slice(0, 10) || ''}
					/></label
				>
			</div>
			<div class="field">
				<label for="note">검토 메모</label><textarea id="note" name="note" maxlength="2000" rows="3"
				></textarea>
			</div>
			<label
				><input type="checkbox" name="reviewed" value="yes" /> 현재 버전의 본문과 출처를 직접 확인했습니다.</label
			>
			<div class="button-row">
				<button class="primary-button" name="action" value="review">현재 버전 검토 완료 기록</button
				><button class="secondary-button" name="action" value="ownership">담당자·기한만 저장</button
				>
			</div>
		</form>
	</section>
	<section class="card">
		<h2>보관 상태</h2>
		<p>
			보관 문서는 일반 검색·AI 근거·지도에서 제외됩니다. 검토·운영 계정은 주소로 열어 확인할 수
			있습니다.
		</p>
		<form method="POST">
			<input type="hidden" name="version" value={data.document.version} /><input
				type="hidden"
				name="action"
				value="archive"
			/><input
				type="hidden"
				name="archived"
				value={data.document.wv_archived_at ? 'no' : 'yes'}
			/><button class="secondary-button"
				>{data.document.wv_archived_at ? '보관 해제' : '문서 보관'}</button
			>
		</form>
	</section>
	{#if data.user?.role === 'admin'}<section class="card">
			<h2>문서 읽기 권한</h2>
			<form method="POST" class="form-row">
				<input type="hidden" name="version" value={data.document.version} /><input
					type="hidden"
					name="action"
					value="access"
				/><label
					>최소 역할<select name="minRole" value={data.document.wv_min_role}
						>{#each roles as role}<option value={role}>{roleLabels[role]} 이상</option
							>{/each}</select
					></label
				><button class="secondary-button">권한 적용</button>
			</form>
		</section>{/if}
	<section class="card">
		<h2>검토 기록</h2>
		{#each data.reviews as review}<article class="search-result">
				<p>
					{review.handle} · {new Date(review.created_at).toLocaleString('ko-KR')} ·
					<a href={`/wiki/${encodeURIComponent(data.document.slug)}?revision=${review.revision_id}`}
						>검토한 리비전 #{review.revision_id}</a
					>
				</p>
				<p>
					{review.note || '메모 없음'} · 다음 검토 {review.next_review_on?.slice(0, 10) || '미지정'}
				</p>
			</article>{:else}<p>아직 사람이 검토한 기록이 없습니다.</p>{/each}
	</section>
</main>
