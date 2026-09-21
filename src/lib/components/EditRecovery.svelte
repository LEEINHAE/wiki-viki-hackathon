<script>
	import StatusNotice from './StatusNotice.svelte';
	import { onMount, untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { editRecoveryStore } from '$lib/edit-recovery.js';
	let {
		scope,
		values,
		dirty,
		saving = false,
		blocked = false,
		onrestore,
		store = editRecoveryStore,
		subject = '문서',
		recoveryHint = ''
	} = $props();
	let ready = $state(false),
		enabled = $state(false),
		copies = $state([]),
		savedAt = $state(null),
		storageError = $state(''),
		notice = $state('');
	let storage = $state.raw();
	let id,
		ignoreNavigation = false;
	const protectedInput = $derived(blocked || !store.safe(scope, values));
	const storageFailure =
		'임시 복구본을 보관하거나 읽지 못했습니다. 현재 입력은 화면에 유지됩니다. 저장하거나 복사해 보관한 뒤 이동해 주세요.';

	function refresh() {
		const result = store.read(storage, scope);
		copies = result.copies.filter((copy) => copy.id !== id);
		if (result.invalid)
			notice = '읽을 수 없는 형식의 복구본이 있습니다. 해당 보관 데이터는 변경하지 않았습니다.';
		else if (result.purged) notice = '보관 기간이 지났거나 보호 검사에 걸린 복구본을 삭제했습니다.';
	}
	function clearCurrent() {
		if (storage && id) store.remove(storage, scope, id);
		savedAt = null;
	}
	function flush(snapshot = store.copyValues(values)) {
		if (!ready || ignoreNavigation) return;
		try {
			if (blocked && storage) {
				store.removeRejected(storage, scope, snapshot);
				refresh();
			}
			if (!enabled || !dirty || blocked || !store.safe(scope, snapshot)) {
				clearCurrent();
				return;
			}
			const record = store.write(storage, scope, id, snapshot);
			savedAt = record?.savedAt ?? null;
			storageError = '';
		} catch {
			storageError = storageFailure;
			savedAt = null;
		}
	}
	$effect(() => {
		const snapshot = store.copyValues(values),
			active = enabled,
			changed = dirty,
			protectedValue = protectedInput;
		if (!ready) return;
		if (!active || !changed || protectedValue) {
			untrack(() => flush(snapshot));
			return;
		}
		const timer = setTimeout(() => flush(snapshot), 400);
		return () => clearTimeout(timer);
	});

	beforeNavigate((navigation) => {
		if (ignoreNavigation || !dirty) return;
		if (
			!navigation.willUnload &&
			navigation.to?.url.pathname === navigation.from?.url.pathname &&
			navigation.to?.url.search === navigation.from?.url.search
		)
			return;
		flush();
		if (navigation.type === 'leave') navigation.cancel();
		else if (
			!window.confirm(
				savedAt && !storageError
					? '저장하지 않은 수정 내용이 있습니다. 임시 복구본은 이 브라우저에 보관됩니다. 편집 화면을 떠날까요?'
					: '저장하지 않은 수정 내용이 있으며 임시 복구를 보장할 수 없습니다. 현재 입력을 잃을 수 있습니다. 편집 화면을 떠날까요?'
			)
		)
			navigation.cancel();
	});

	onMount(() => {
		try {
			id = crypto.randomUUID();
			storage = window.localStorage;
			refresh();
		} catch {
			storageError = storageFailure;
		}
		ready = true;
		const hide = () => flush();
		const visibility = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		const changed = (event) => {
			if (event.storageArea !== storage || (event.key && !event.key.startsWith(store.prefix)))
				return;
			try {
				if ((!event.key || event.key === store.key(scope, id)) && event.newValue === null) {
					enabled = false;
					savedAt = null;
					notice =
						'다른 탭에서 이 복구본을 삭제해 임시 보관을 중지했습니다. 화면의 입력은 유지했습니다.';
				}
				refresh();
			} catch {
				storageError = storageFailure;
			}
		};
		window.addEventListener('pagehide', hide);
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('storage', changed);
		return () => {
			window.removeEventListener('pagehide', hide);
			document.removeEventListener('visibilitychange', visibility);
			window.removeEventListener('storage', changed);
		};
	});

	function restore(copyId) {
		if (
			dirty &&
			!window.confirm(
				'현재 화면의 입력을 선택한 임시 복구본으로 바꿀까요? 필요한 입력은 먼저 복사해 보관하세요.'
			)
		)
			return;
		try {
			const copy = store.read(storage, scope).copies.find((copy) => copy.id === copyId);
			if (!copy) {
				refresh();
				notice = '복구본이 만료되었거나 삭제되었습니다. 현재 입력은 바꾸지 않았습니다.';
				return;
			}
			onrestore(store.copyValues(copy.values));
			enabled = !blocked;
			try {
				if (blocked) {
					clearCurrent();
					refresh();
					return;
				}
				const saved = store.write(storage, scope, id, copy.values);
				savedAt = saved.savedAt;
				storageError = '';
			} catch {
				savedAt = null;
				storageError = storageFailure;
			}
			refresh();
			notice = `입력을 복구했습니다. 원래 검토 버전을 유지해 저장할 때 현재 ${subject}${subject === '초안' ? '과' : '와'} 다시 비교합니다. 원본 복구본은 목록에서 삭제할 수 있습니다.`;
		} catch {
			storageError = storageFailure;
		}
	}
	function discard(copyId) {
		try {
			store.remove(storage, scope, copyId);
			refresh();
			notice = '선택한 임시 복구본을 삭제했습니다. 화면의 입력은 유지했습니다.';
		} catch {
			storageError = storageFailure;
		}
	}
	export function reject(snapshot = store.copyValues(values)) {
		try {
			store.removeRejected(storage, scope, snapshot);
			refresh();
		} catch {
			storageError = storageFailure;
		}
	}
	export function beforeSubmit() {
		flush();
	}
	export function complete(clear = true) {
		ignoreNavigation = true;
		if (clear) {
			enabled = false;
			try {
				clearCurrent();
			} catch {
				storageError = storageFailure;
			}
		}
	}
</script>

<section class="recovery-panel" aria-label="임시 입력 복구">
	<h2>임시 입력 복구</h2>
	{#if recoveryHint}<p class="small">{recoveryHint}</p>{/if}
	<p class="small">
		임시 복구본은 이 브라우저에만 저장합니다. 서버·AI의 보관 기능을 사용하지 않으며, 같은 기기를
		쓰는 사람에게 보일 수 있습니다.
	</p>
	<label class="recovery-choice"
		><input
			type="checkbox"
			bind:checked={enabled}
			disabled={!ready || saving || protectedInput || !storage}
		/> 민감 정보가 없는 입력을 이 브라우저에 24시간 임시 보관</label
	>
	<p class="small muted">
		마지막 보관 후 24시간이 지나면 편집 화면을 다시 열 때 삭제합니다. 체크를 끄면 이 화면의 복구본을
		삭제합니다. 이전 복구본은 목록에서 각각 삭제할 수 있습니다.
	</p>
	{#if !ready}<p role="status">임시 복구본을 확인하고 있습니다.</p>
	{:else if protectedInput}<StatusNotice tone="warning" role="status">
			현재 입력 또는 직전 저장 시도가 보호 검사에 걸려 브라우저 임시 보관을 중지했습니다. 현재
			입력은 이 화면에 유지됩니다. 저장할 수 있는 내용으로 수정하거나 입력을 보관한 뒤 이동해
			주세요.
		</StatusNotice>
	{:else if savedAt && !storageError}<p class="small" role="status">
			이 브라우저에 임시 보관됨 · {new Date(savedAt).toLocaleTimeString('ko-KR')} ({subject} 저장 전)
		</p>
	{:else if dirty}<p class="small" role="status">
			{subject}에 저장하지 않은 수정 내용이 있습니다.
		</p>{/if}
	{#if storageError}<StatusNotice tone="error" role="alert">{storageError}</StatusNotice>{/if}
	{#if notice}<p class="small" role="status">{notice}</p>{/if}
	{#if ready && !storageError && !copies.length}<p class="small muted">
			이 주소에서 복구할 이전 입력이 없습니다.
		</p>{/if}
	{#each copies as copy}
		<div class="recovery-copy">
			<p>
				<strong>{copy.values.title || '제목 미입력'}</strong> · {new Date(
					copy.savedAt
				).toLocaleString('ko-KR')}
			</p>
			<p class="small muted">다른 창에서 작성한 입력도 별도 복구본으로 보관합니다.</p>
			<div class="button-row">
				<button
					type="button"
					class="secondary-button"
					disabled={saving}
					onclick={() => restore(copy.id)}>이 입력 복구</button
				>
				<button
					type="button"
					class="danger-button"
					disabled={saving}
					onclick={() => discard(copy.id)}>이 복구본 삭제</button
				>
			</div>
		</div>
	{/each}
	<noscript
		><StatusNotice tone="warning" role={null}>
			<p>
				임시 복구와 이동 전 안내에는 JavaScript가 필요합니다. 이동·새로고침 전에 작성 내용을
				저장하거나 복사해 보관해 주세요.
			</p>
		</StatusNotice></noscript
	>
</section>

<style>
	.recovery-panel {
		border: 1px solid var(--line);
		border-radius: var(--inset-radius);
		padding: var(--inset-padding);
		margin: 1.25rem 0;
	}
	.recovery-panel h2 {
		font-size: 1.1rem;
		margin-top: 0;
	}
	.recovery-choice {
		display: flex;
		gap: 0.5rem;
		align-items: start;
	}
	.recovery-choice input {
		margin-top: 0.3rem;
	}
	.recovery-copy {
		border-top: 1px solid var(--line);
		margin-top: 1rem;
		padding-top: 0.5rem;
		overflow-wrap: anywhere;
	}
</style>
