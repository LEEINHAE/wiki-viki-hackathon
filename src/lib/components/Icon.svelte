<script>
	let { name = 'search', size = 20 } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'search'}<circle cx="10.8" cy="10.8" r="7.3" /><path d="m16 16 4.5 4.5" />
	{:else if name === 'sparkles'}<path
			d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"
		/>
	{:else if name === 'upload'}<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
	{:else if name === 'close'}<path d="m6 6 12 12M6 18 18 6" />
	{:else if name === 'file'}<path d="M14 2H5v20h14V7l-5-5v5h5M8 12h8M8 16h6" />
	{:else if name === 'moon'}<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
	{:else if name === 'sun'}<circle cx="12" cy="12" r="4" /><path
			d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"
		/>
	{:else if name === 'check'}<path d="m5 12 4 4L19 6" />
	{:else}<path d="M4 12h16m-6-6 6 6-6 6" />{/if}
</svg>
