<script>
	import { roleLabels, roles } from '$lib/auth-policy.js';
	let { data, form } = $props();
</script>

<svelte:head><title>계정 관리 — 위키비키</title></svelte:head>
<main class="page-shell">
	<h1>계정과 권한</h1>
	<p>권한 또는 활성 상태를 바꾸면 해당 계정의 모든 세션이 종료됩니다.</p>
	{#if form?.message}<p class="notice warning" role="alert">{form.message}</p>{/if}
	<section class="card">
		<h2>계정 추가</h2>
		<form method="POST" action="?/create" class="form-row">
			<label
				>계정 이름<input name="handle" placeholder="Editor-01" required autocomplete="off" /></label
			><label
				>초기 비밀번호<input
					type="password"
					name="password"
					minlength="12"
					maxlength="128"
					autocomplete="new-password"
					required
				/></label
			><label
				>역할<select name="role"
					>{#each roles as role}<option value={role}>{roleLabels[role]}</option>{/each}</select
				></label
			><button class="primary-button">계정 생성</button>
		</form>
	</section>
	<section class="card">
		<h2>계정 목록</h2>
		{#each data.users as user}<form method="POST" action="?/access" class="search-result form-row">
				<input type="hidden" name="id" value={user.id} /><strong>{user.handle}</strong><label
					>역할<select name="role" value={user.role}
						>{#each roles as role}<option value={role}>{roleLabels[role]}</option>{/each}</select
					></label
				><label
					><input type="checkbox" name="active" value="yes" checked={user.active} /> 사용 가능</label
				><button class="secondary-button">변경 적용</button>
			</form>{/each}
	</section>
	<section class="card">
		<h2>최근 권한 변경</h2>
		<ul>
			{#each data.events as event}<li>
					{event.subject} · {event.action === 'created' ? '계정 생성' : '권한 변경'} · {roleLabels[
						event.details.role
					]} · {event.actor || '서버 운영 명령'} · {new Date(event.created_at).toLocaleString(
						'ko-KR'
					)}
				</li>{/each}
		</ul>
	</section>
</main>
