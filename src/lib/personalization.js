const KEY = 'wiki-library';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
export function readLibrary() {
	const value = JSON.parse(localStorage.getItem(KEY) || '{}');
	const valid = (item) => item && /^\d+$/.test(String(item.id)) && Number.isFinite(item.at);
	return {
		favorites: Array.isArray(value.favorites) ? value.favorites.filter(valid).slice(0, 100) : [],
		recent: Array.isArray(value.recent)
			? value.recent.filter((item) => valid(item) && Date.now() - item.at < MAX_AGE).slice(0, 30)
			: []
	};
}
export function rememberDocument(id) {
	const value = readLibrary();
	value.recent = [
		{ id: String(id), at: Date.now() },
		...value.recent.filter((item) => String(item.id) !== String(id))
	].slice(0, 30);
	localStorage.setItem(KEY, JSON.stringify(value));
	window.dispatchEvent(new Event('wiki-library-change'));
}
export function toggleFavorite(id) {
	const value = readLibrary();
	const exists = value.favorites.some((item) => String(item.id) === String(id));
	value.favorites = exists
		? value.favorites.filter((item) => String(item.id) !== String(id))
		: [{ id: String(id), at: Date.now() }, ...value.favorites].slice(0, 100);
	localStorage.setItem(KEY, JSON.stringify(value));
	window.dispatchEvent(new Event('wiki-library-change'));
	return !exists;
}
export function clearPersonalization() {
	localStorage.removeItem(KEY);
	localStorage.removeItem('wiki-reading');
	window.dispatchEvent(new Event('wiki-library-change'));
	window.dispatchEvent(new Event('wiki-reading-change'));
}
