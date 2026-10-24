export async function selectQueryRecord(page, query) {
	const back = page.getByRole('button', { name: '返回查询结果', exact: true });
	if (await back.count()) {
		await back.click();
	}
	await page.getByRole('button', { name: '查询记录', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: '查询记录', exact: true });
	await dialog.getByRole('button', { name: `查看查询记录 ${query}`, exact: true }).click();
	await dialog.waitFor({ state: 'hidden' });
}
