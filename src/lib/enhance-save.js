export function enhanceSave({ formElement }) {
	return async ({ result, update }) => {
		formElement.dispatchEvent(
			new Event(result.type === 'redirect' || result.type === 'success' ? 'saved' : 'savefailed')
		);
		await update({ reset: false });
	};
}
