export async function openPeople(page, scope = 'actors', tab = 'browse') {
	await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: scope === 'actors' ? '演员' : '创作者', exact: true }).click();
	await page.getByRole('tablist', { name: scope === 'actors' ? '演员页面' : '创作者页面', exact: true }).getByRole('tab', { name: tab === 'manage' ? '管理' : '浏览', exact: true }).click();
}

export async function openUpdates(page, scope = 'creators', all = true) {
	await openPeople(page, scope);
	const unread = page.locator('.person-card').filter({ has: page.locator('.person-card-unread') }).first();
	const person = await unread.count() ? unread : page.locator('.person-card').first();
	await person.click();
	await page.getByRole('tab', { name: all ? '全部' : '未读', exact: true }).click();
}

export async function openProfile(page, name, scope = 'actors') {
	await openPeople(page, scope, 'manage');
	await page.locator('.subscription-name').filter({ hasText: name }).click();
	await page.locator('.person-profile').waitFor();
}
