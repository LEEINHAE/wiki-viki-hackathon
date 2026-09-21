<script>
	import { roleLabels } from '$lib/auth-policy.js';
	let { data, form } = $props();
</script>

<svelte:head><title>내 계정 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>내 계정</h1>
	<p>{data.user?.handle} · {roleLabels[data.user?.role]} · 유효한 로그인 {data.sessions}개</p>
	<section class="card" style="max-width:520px">
		<h2>비밀번호 변경</h2>
		<p>변경하면 모든 기기에서 로그아웃됩니다.</p>
		{#if form?.message}<p class="notice warning" role="alert">{form.message}</p>{/if}
		<form method="POST" action="?/password">
			<div class="field">
				<label for="current">현재 비밀번호</label><input
					id="current"
					name="current"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			<div class="field">
				<label for="password">새 비밀번호 · 12~128자</label><input
					id="password"
					name="password"
					type="password"
					autocomplete="new-password"
					minlength="12"
					maxlength="128"
					required
				/>
			</div>
			<div class="field">
				<label for="confirm">새 비밀번호 확인</label><input
					id="confirm"
					name="confirm"
					type="password"
					autocomplete="new-password"
					required
				/>
			</div>
			<button class="primary-button">비밀번호 변경 후 로그아웃</button>
		</form>
	</section>
</main>
