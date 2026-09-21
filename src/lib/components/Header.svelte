<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import SearchBox from './SearchBox.svelte';
	import Icon from './Icon.svelte';
	import WikifyButton from './WikifyButton.svelte';
	let dark = $state(false);
	let mobileMenu, menuToggle, desktopNav, header, focusedNavigation, modalNavigation;
	const homeView = $derived(
		page.url.pathname !== '/'
			? null
			: page.url.searchParams.get('q')?.trim()
				? 'search'
				: ['activity', 'map'].includes(page.url.searchParams.get('view'))
					? page.url.searchParams.get('view')
					: 'search'
	);

	function closeMobileMenu() {
		if (mobileMenu) mobileMenu.open = false;
	}
	afterNavigate(() => {
		focusedNavigation = null;
		modalNavigation = null;
		closeMobileMenu();
	});
	function closeMenu(event) {
		if (event.key === 'Escape' && mobileMenu?.open && mobileMenu.contains(event.target)) {
			event.preventDefault();
			closeMobileMenu();
			menuToggle?.focus();
		}
	}

	onMount(() => {
		dark = document.documentElement.dataset.theme === 'dark';
		try {
			dark = localStorage.getItem('wiki-theme') === 'dark';
		} catch {
			/* Keep the initial theme when storage is unavailable. */
		}
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		const media = window.matchMedia('(max-width: 800px)');
		function desktopLink(href) {
			const links = [...desktopNav.querySelectorAll('a')];
			return links.find((link) => link.getAttribute('href') === href) || links[0];
		}
		function resizeMenu() {
			// CSS can move focus to body before the media change event is delivered.
			const active =
				document.activeElement === document.body ? focusedNavigation : document.activeElement;
			if (media.matches && desktopNav?.contains(active)) {
				menuToggle?.focus();
			} else if (!media.matches && mobileMenu?.contains(active)) {
				const href = active?.getAttribute('href');
				desktopLink(href)?.focus();
			}
			closeMobileMenu();
		}
		function dismissOutside(event) {
			const inNavigation = mobileMenu?.contains(event.target) || desktopNav?.contains(event.target);
			if (event.type === 'focusin') {
				const dialog = event.target.closest('dialog[open]');
				if (dialog && focusedNavigation) {
					modalNavigation = { dialog, launcher: focusedNavigation };
				}
				focusedNavigation = inNavigation ? event.target : null;
			} else if (!inNavigation) focusedNavigation = null;
			// Keep the visible launcher available for the dialog's native focus return.
			if (
				mobileMenu?.open &&
				!mobileMenu?.contains(event.target) &&
				!document.querySelector('dialog[open]')
			) {
				closeMobileMenu();
			}
		}
		function restoreModalFocus(event) {
			if (modalNavigation?.dialog !== event.target) return;
			const { launcher } = modalNavigation;
			modalNavigation = null;
			// A breakpoint change can hide the dialog's original return target.
			if (!launcher.getClientRects().length) {
				(media.matches ? menuToggle : desktopLink(launcher.getAttribute('href')))?.focus();
			}
		}
		const observer = new ResizeObserver(() => {
			document.documentElement.style.setProperty(
				'--header-height',
				`${header.getBoundingClientRect().height}px`
			);
		});
		observer.observe(header);
		media.addEventListener('change', resizeMenu);
		document.addEventListener('focusin', dismissOutside);
		document.addEventListener('pointerdown', dismissOutside);
		document.addEventListener('close', restoreModalFocus, true);
		return () => {
			observer.disconnect();
			document.documentElement.style.removeProperty('--header-height');
			media.removeEventListener('change', resizeMenu);
			document.removeEventListener('focusin', dismissOutside);
			document.removeEventListener('pointerdown', dismissOutside);
			document.removeEventListener('close', restoreModalFocus, true);
		};
	});
	function toggleTheme() {
		dark = !dark;
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		try {
			localStorage.setItem('wiki-theme', dark ? 'dark' : 'light');
		} catch {
			/* Storage may be disabled. */
		}
	}
</script>

<svelte:window onkeydown={closeMenu} />

{#snippet links()}
	<a href="/?view=search#wiki-search" aria-current={homeView === 'search' ? 'page' : undefined}
		>검색</a
	>
	<a href="/?view=map#explore" aria-current={homeView === 'map' ? 'page' : undefined}>문서 탐색</a>
	<a href="/?view=activity" aria-current={homeView === 'activity' ? 'page' : undefined}>최근 변경</a
	><a href="/drafts" aria-current={page.url.pathname === '/drafts' ? 'page' : undefined}
		>초안 검토</a
	>
	<a class="nav-create" href="/new" aria-current={page.url.pathname === '/new' ? 'page' : undefined}
		>새 문서 작성</a
	>
	<WikifyButton class="nav-link">AI 위키파이어</WikifyButton>
	<a href="/trash" aria-current={page.url.pathname === '/trash' ? 'page' : undefined}>휴지통</a>
	<a href="/links" aria-current={page.url.pathname === '/links' ? 'page' : undefined}>자동 연결</a>
{/snippet}

<header class="topbar" bind:this={header}>
	<div class="nav-wrap">
		<a class="brand" href="/" aria-label="위키비키 홈"
			><span class="brand-mark">W</span><span>위키비키</span></a
		>
		<nav class="desktop-nav" aria-label="주요 메뉴" bind:this={desktopNav}>
			{@render links()}
		</nav>
		<div class="header-tools">
			{#if page.url.pathname !== '/' || page.url.searchParams.has('q')}<SearchBox
					compact
					initial={page.url.searchParams.get('q') || ''}
				/>{/if}
			<button
				class="theme-button"
				onclick={toggleTheme}
				aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'}
				title={dark ? '라이트 모드' : '다크 모드'}
				><Icon name={dark ? 'sun' : 'moon'} size={18} /></button
			>
			<div class="editor-badge" title="기본 익명 편집자 표시입니다. 로그인 계정이 아닙니다.">
				<span>01</span><b>Editor-01</b>
			</div>
		</div>
		<details class="mobile-menu" bind:this={mobileMenu}>
			<summary class="secondary-button" bind:this={menuToggle}>
				메뉴 <Icon name="arrow" size={16} />
			</summary>
			<nav aria-label="주요 메뉴">{@render links()}</nav>
		</details>
	</div>
</header>
