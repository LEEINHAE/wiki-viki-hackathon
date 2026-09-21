<script>
	let { tone = 'info', title, role = 'status', children } = $props();
	const titles = {
		info: '안내',
		warning: '확인 필요',
		error: '문제 발생',
		success: '완료',
		pending: '처리 중'
	};
</script>

<div
	class="notice state-notice"
	class:warning={tone === 'warning'}
	class:error={tone === 'error'}
	class:success={tone === 'success'}
	class:pending={tone === 'pending'}
	{role}
>
	<strong class="notice-title">{title || titles[tone] || titles.info}</strong>
	<div class="notice-body">{@render children?.()}</div>
</div>
