// Exercise shadcn Select through the same controls a user operates.
export async function chooseOption(page, name, option) {
	await page.getByRole('combobox', { name, exact: true }).click();
	await page.getByRole('option', { name: option, exact: true }).click();
	await page.locator(`[data-slot="select-content"][aria-label="${name}选项"]`).waitFor({ state: 'hidden' });
}
