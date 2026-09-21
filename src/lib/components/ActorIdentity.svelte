<script>
	import { page } from '$app/state';
	let {
		value = $bindable('Operator-07'),
		name = 'editor',
		id = 'actor',
		label = '작업자'
	} = $props();
</script>

<div class="field">
	{#if page.data.user}<p class="muted">{label} · {page.data.user.handle}</p>
		<input type="hidden" {name} value={page.data.user.handle} />
	{:else}<label for={id}>익명 {label} 이름</label><input
			{id}
			{name}
			bind:value
			required
			placeholder="Operator-07"
		/>{/if}
</div>
