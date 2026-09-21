export async function openMainMenu(page) {
	const toggle = page.locator('.mobile-menu summary');
	const navigation = page.getByRole('navigation', { name: '주요 메뉴', exact: true });
	if (await toggle.isVisible()) {
		if (!(await navigation.isVisible())) {
			await toggle.focus();
			await page.keyboard.press('Enter');
		}
	}
	await navigation.waitFor();
	return navigation;
}
