import assert from 'node:assert/strict';

// Exercise the actual breakpoint in both directions while a rendered control,
// its tab, or the textarea owns keyboard focus. All three editing flows share it.
export async function verifyPreviewResizeFocus(page, editor) {
	const originalViewport = page.viewportSize();
	const panel = editor.locator('.preview-panel');
	const input = editor.locator('textarea');
	const content = await input.inputValue();
	const html = await panel.locator('.wiki-content').innerHTML();
	const panelId = await panel.getAttribute('id');
	const editTab = editor.getByRole('tab', { name: '편집', exact: true });
	const previewTab = editor.getByRole('tab', { name: '미리보기', exact: true });
	const link = panel.locator('.section-number').first();
	const wide = async () => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await previewTab.waitFor({ state: 'detached' });
		assert.equal(await panel.getAttribute('role'), 'region');
		assert.equal(await panel.getAttribute('tabindex'), '-1');
		assert.equal(
			await panel.getAttribute('aria-labelledby'),
			await panel.locator('h2').first().getAttribute('id')
		);
	};
	const narrow = async () => {
		await page.setViewportSize({ width: 768, height: 1000 });
		await previewTab.waitFor();
		assert.equal(await panel.getAttribute('role'), 'tabpanel');
		assert.equal(await panel.getAttribute('tabindex'), '0');
		assert.equal(await panel.getAttribute('aria-labelledby'), await previewTab.getAttribute('id'));
	};
	const focused = async (locator) =>
		assert.equal(await locator.evaluate((el) => el === document.activeElement), true);
	try {
		await wide();
		await link.focus();
		await narrow();
		await focused(link);
		assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
		await page.keyboard.press('Enter');
		assert.equal(new URL(page.url()).hash, await link.getAttribute('href'));
		await link.focus();
		await wide();
		await focused(link);
		const table = panel.getByRole('region', { name: '표 1', exact: true });
		await table.focus();
		await narrow();
		await focused(table);
		await wide();
		await focused(table);

		await narrow();
		await previewTab.focus();
		await wide();
		await page.waitForFunction((id) => document.activeElement.id === id, panelId);
		await focused(panel);
		assert.notEqual(await panel.evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
		await narrow();
		await focused(panel);
		assert.equal(await previewTab.getAttribute('aria-selected'), 'true');

		await editTab.click();
		await input.focus();
		await wide();
		await focused(input);
		await narrow();
		await focused(input);
		assert.equal(await editTab.getAttribute('aria-selected'), 'true');
		await editTab.focus();
		await wide();
		await page.waitForFunction(
			(id) => document.activeElement.id === id,
			await input.getAttribute('id')
		);
		await focused(input);
		assert.equal(await input.inputValue(), content);
		assert.equal(await panel.locator('.wiki-content').innerHTML(), html);
		const title = page.getByLabel('문서 제목', { exact: true });
		await title.focus();
		await narrow();
		await focused(title);
		await wide();
		await focused(title);
	} finally {
		await page.setViewportSize(originalViewport);
		if (originalViewport.width < 1024) await previewTab.click();
	}
}
