<script>
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { regexGovernance } from '$lib/content-policy.js';
	import { recoveryValues } from '$lib/recovery-policy.js';
	let { element, storageKey, kind = 'new_document', resources = [] } = $props();
	let dirty = $state(false),
		submitting = $state(false),
		status = $state(''),
		backup = $state(null);
	let saveNow = () => {},
		clearBackup = async () => {};
	const prefix = 'wiki-recovery:';
	const scopedKey = $derived(`${page.data.user?.id || 'browser'}:${storageKey}`);
	const server = $derived(!!page.data.user);
	function restore() {
		if (!element || !backup) return;
		for (const [key, value] of Object.entries(recoveryValues(backup.values))) {
			const control = element.elements.namedItem(key);
			if (control && 'value' in control && control.type !== 'checkbox') {
				control.value = String(value);
				control.dispatchEvent(new Event('input', { bubbles: true }));
				control.dispatchEvent(new Event('change', { bubbles: true }));
			}
		}
		backup = null;
		dirty = true;
		status = '임시 입력을 복구했습니다. 차이를 확인한 뒤 저장해 주세요.';
	}
	beforeNavigate(({ cancel }) => {
		if (
			dirty &&
			!submitting &&
			!confirm('저장하지 않은 변경이 있습니다. 다른 화면으로 이동할까요?')
		)
			cancel();
	});
	$effect(() => {
		const node = element,
			key = prefix + scopedKey,
			useServer = server;
		const scope = { key: storageKey, kind, resources: JSON.parse(JSON.stringify(resources)) };
		if (!node) return;
		// SvelteKit can reuse this component when moving between documents.
		// A previous document's recovery prompt must never apply to the new form.
		dirty = false;
		submitting = false;
		status = '';
		backup = null;
		const read = () => recoveryValues(Object.fromEntries(new FormData(node)));
		const comparable = (values) =>
			JSON.stringify(
				Object.fromEntries(
					Object.entries(values).filter(
						([k]) => !['id', 'version', 'sourceVersion', 'targetVersion', 'mergeId'].includes(k)
					)
				)
			);
		let initial = comparable(read()),
			timer,
			closed = false,
			version = '',
			queue = Promise.resolve();
		// Parent effects may populate the editor after this effect first runs.
		// Capture the settled initial DOM, before any user input can occur.
		const ready = tick().then(() => {
			if (!closed) initial = comparable(read());
		});
		const show = (message) => {
			if (!closed) status = message;
		};
		const post = async (payload) => {
			const body = JSON.stringify({ ...scope, ...payload, version });
			const response = await fetch('/api/recovery', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
				keepalive: new TextEncoder().encode(body).length < 60000
			});
			const result = await response.json();
			if (!response.ok) throw Error(result.message || '임시 보관에 실패했습니다.');
			version = result.version || '';
			return result;
		};
		const enqueue = (work) => {
			queue = queue.then(work).catch((cause) => show(cause.message || '임시 보관에 실패했습니다.'));
			return queue;
		};
		if (useServer) {
			queue = ready
				.then(() => fetch(`/api/recovery?key=${encodeURIComponent(scope.key)}`))
				.then(async (response) => {
					if (!response.ok) throw Error('서버의 임시 입력을 불러오지 못했습니다.');
					const result = await response.json();
					version = result.version || result.backup?.version || '';
					let stored = result.backup;
					// Migrate this account's earlier browser backup without discarding it.
					if (!stored) {
						try {
							const legacy = JSON.parse(localStorage.getItem(key) || 'null');
							if (legacy?.expires > Date.now() && legacy.values) {
								const values = recoveryValues(legacy.values);
								if (
									regexGovernance(Object.values(values).join('\n'), {
										mode: page.data.contentPolicy
									}).passed
								) {
									const saved = await post({ action: 'save', values });
									stored = { ...saved, values };
									localStorage.removeItem(key);
								}
							}
						} catch {}
					}
					if (!closed && stored && comparable(stored.values) !== initial) backup = stored;
				})
				.catch(() =>
					show('서버 임시 입력을 불러오지 못했습니다. 현재 입력은 이 화면에 유지됩니다.')
				);
		} else {
			ready.then(() => {
				try {
					for (let i = localStorage.length - 1; i >= 0; i--) {
						const k = localStorage.key(i);
						if (k?.startsWith(prefix)) {
							try {
								const s = JSON.parse(localStorage.getItem(k));
								if (!s?.expires || s.expires < Date.now()) localStorage.removeItem(k);
							} catch {
								localStorage.removeItem(k);
							}
						}
					}
					const stored = JSON.parse(localStorage.getItem(key) || 'null');
					if (stored?.values && comparable(stored.values) !== initial) backup = stored;
				} catch {
					show('브라우저 임시 저장을 사용할 수 없습니다.');
				}
			});
		}
		clearBackup = () =>
			enqueue(async () => {
				if (useServer) await post({ action: 'delete' });
				try {
					localStorage.removeItem(key);
				} catch {}
				if (!closed) backup = null;
				show('임시 입력을 삭제했습니다.');
			});
		const save = () => {
			const values = read();
			dirty = comparable(values) !== initial;
			if (!dirty) return;
			if (backup) {
				show('남아 있는 임시 입력을 복구하거나 삭제한 뒤 새 입력을 임시 보관할 수 있습니다.');
				return;
			}
			if (
				!regexGovernance(Object.values(values).join('\n'), { mode: page.data.contentPolicy }).passed
			) {
				clearBackup();
				show('콘텐츠 검사에 걸린 입력은 임시 보관하지 않습니다. 현재 화면에서 수정해 주세요.');
				return;
			}
			show('미저장 변경 · 임시 보관 중…');
			enqueue(async () => {
				if (useServer) await post({ action: 'save', values });
				else localStorage.setItem(key, JSON.stringify({ values, expires: Date.now() + 86400000 }));
				show(
					useServer
						? '미저장 변경 · 내 계정의 서버 임시 입력으로 보관됨 (24시간)'
						: '미저장 변경 · 이 브라우저에 24시간 임시 보관'
				);
			});
		};
		saveNow = save;
		const change = () => {
			dirty = comparable(read()) !== initial;
			submitting = false;
			clearTimeout(timer);
			timer = setTimeout(save, useServer ? 750 : 250);
		};
		const submit = () => {
			clearTimeout(timer);
			save();
			submitting = true;
		};
		const saved = () => {
			clearTimeout(timer);
			dirty = false;
			submitting = false;
			initial = comparable(read());
			clearBackup();
		};
		const failed = () => {
			submitting = false;
		};
		const leave = (event) => {
			if (dirty && !submitting) {
				save();
				event.preventDefault();
				event.returnValue = '';
			}
		};
		node.addEventListener('input', change);
		node.addEventListener('change', change);
		node.addEventListener('submit', submit);
		node.addEventListener('saved', saved);
		node.addEventListener('savefailed', failed);
		window.addEventListener('beforeunload', leave);
		return () => {
			closed = true;
			clearTimeout(timer);
			node.removeEventListener('input', change);
			node.removeEventListener('change', change);
			node.removeEventListener('submit', submit);
			node.removeEventListener('saved', saved);
			node.removeEventListener('savefailed', failed);
			window.removeEventListener('beforeunload', leave);
		};
	});
</script>

<div class="recovery-status" aria-live="polite">
	{#if backup}<p>
			이 화면에서 저장하지 않은 임시 입력이 있습니다. 복구해도 게시·검토 확인은 다시 선택해야
			합니다.
		</p>
		<button class="secondary-button" type="button" onclick={restore}>임시 입력 복구</button>{/if}
	<small
		>{status ||
			(server
				? '내 계정으로 서버에서 24시간 복구할 수 있습니다. 브라우저에는 새 본문을 저장하지 않습니다.'
				: '임시 입력은 현재 브라우저에 최대 24시간 보관됩니다.')}</small
	>
	{#if server}<small
			>현재 문서 권한이 있어야 복구할 수 있습니다. 만료된 입력은 다음 임시 저장·조회 때 삭제됩니다.</small
		>{/if}
	<div class="button-row">
		<button type="button" class="secondary-button" onclick={() => saveNow()}>지금 임시 보관</button
		><button type="button" class="secondary-button" onclick={() => clearBackup()}
			>임시 입력 삭제</button
		>
	</div>
</div>
