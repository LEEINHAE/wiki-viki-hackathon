export const roles = ['reader', 'editor', 'reviewer', 'admin'];
export const roleLabels = { reader: '읽기', editor: '편집', reviewer: '검토', admin: '운영' };
export function permits(role, needed) {
	return (
		roles.includes(role) && roles.includes(needed) && roles.indexOf(role) >= roles.indexOf(needed)
	);
}
export function requiredRole(path, method, action = '') {
	if (path.startsWith('/api/uploads/')) return 'editor';
	if (path.startsWith('/admin') || path === '/trash') return 'admin';
	if (path.startsWith('/manage/') || path === '/reviews') return 'reviewer';
	if (path.startsWith('/merge/')) return 'reviewer';
	if (path.startsWith('/history/') && action === 'restoreState') return 'admin';
	if (path === '/drafts')
		return method === 'POST' &&
			['publish', 'publishSelected', 'markReviewed', 'applyMerge'].includes(action)
			? 'reviewer'
			: 'editor';
	if (path.startsWith('/edit/')) return action === 'delete' ? 'admin' : 'editor';
	if (path.startsWith('/proposals/'))
		return method === 'POST' && action === 'decide' ? 'reviewer' : 'reader';
	if (path.startsWith('/history/') && method === 'POST') return 'reviewer';
	if (['/wikify', '/uploads', '/api/wikify', '/api/uploads'].includes(path)) return 'editor';
	if (
		method === 'POST' &&
		![
			'/api/answer',
			'/api/library',
			'/api/trending',
			'/api/personal',
			'/api/preview',
			'/api/recovery',
			'/notifications',
			'/account',
			'/collections'
		].includes(path) &&
		!path.startsWith('/discussion/')
	)
		return 'editor';
	return 'reader';
}
export function canAccessRoute(role, path, method = 'GET', action = '') {
	// These document workflows are unavailable in administrator mode.
	if (
		role === 'admin' &&
		(path.startsWith('/proposals/') || path.startsWith('/manage/') || path === '/reviews')
	)
		return false;
	return permits(role, requiredRole(path, method, action));
}
export function localReturn(value) {
	return typeof value === 'string' &&
		value.startsWith('/') &&
		!value.startsWith('//') &&
		!/[\\\x00-\x1f]/.test(value)
		? value
		: '/';
}
