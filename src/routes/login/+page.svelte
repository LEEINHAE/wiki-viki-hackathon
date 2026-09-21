<script>
	let { data, form } = $props();
</script>

<svelte:head><title>로그인 — 위키비키</title></svelte:head>
<main class="page-shell">
	<section class="card" style="max-width:480px;margin:32px auto">
		<h1>사내 위키 로그인</h1>
		<p>운영 담당자가 발급한 계정으로 로그인하세요.</p>
		{#if form?.message}<p role="alert" class="notice warning">{form.message}</p>{/if}
		<form method="POST">
			<input type="hidden" name="next" value={data.next} />
			<div class="field">
				<label for="handle">계정 이름</label><input
					id="handle"
					name="handle"
					autocomplete="username"
					value={form?.handle || data.handle || ''}
					required
					placeholder="Editor-01"
				/>
			</div>
			<div class="field">
				<label for="password">비밀번호</label><input
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					minlength="12"
					maxlength="128"
					required
				/>
			</div>
			<button class="primary-button">로그인</button>
		</form>
	</section>
</main>
