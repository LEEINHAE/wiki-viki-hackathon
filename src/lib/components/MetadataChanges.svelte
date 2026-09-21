<script>
	let { changes = [] } = $props();
</script>

{#if changes.length}<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable comparison needs keyboard focus.) -->
	<div class="table-scroll" role="region" aria-label="메타데이터 변경 비교" tabindex="0">
		<table>
			<thead><tr><th>항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody
				>{#each changes as row}<tr
						><th scope="row">{row.label}</th><td
							><span class="metadata-value">{row.before}</span></td
						><td><span class="metadata-value">{row.after}</span></td></tr
					>{/each}</tbody
			>
		</table>
	</div>{:else}<p class="muted">기록된 메타데이터 변경이 없습니다.</p>{/if}

<style>
	.table-scroll {
		overflow: auto;
		max-width: 100%;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		padding: 0.65rem;
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid var(--line);
		min-width: 7rem;
	}
	.metadata-value {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 0.85rem;
	}
</style>
