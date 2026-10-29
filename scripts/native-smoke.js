(async () => {
	const { invoke } = window.__TAURI_INTERNALS__;
	const checks = [];
	const assert = (value, label) => {
		if (!value) {
			throw new Error(label);
		}
		checks.push(label);
	};
	const until = async (read, label) => {
		const started = Date.now();
		while (Date.now() - started < 20000) {
			const value = await read();
			if (value) {
				return value;
			}
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		throw new Error(`Timeout: ${label}`);
	};
	const button = (label) => [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === label || el.textContent.trim() === label);
	const click = async (label) => (await until(() => button(label), label)).click();
	const snapshot = async (name) => {
		await new Promise((resolve) => setTimeout(resolve, 150));
		await invoke('smoke_snapshot', { name });
	};
	try {
		await until(() => window.nectisse, 'Tauri bridge');
		const ids = await invoke('smoke_seed');
		const bridge = window.nectisse;
		const runtime = await until(async () => {
			const state = await bridge.runtime.getState();
			return state.phase !== 'starting' && state;
		}, 'bundled Python');
		assert(runtime.phase === 'ready', `Bundled Python health: ${JSON.stringify(runtime)}`);
		const state = await bridge.subscriptions.getState();
		assert(state.subscriptions.length === 3, 'Validated Rust subscription snapshot');
		const page = await bridge.subscriptions.getEntries({ subscriptionId: ids.creator, page: 2, pageSize: 40, unread: false });
		assert(page.total === 65 && page.entries.length === 25, 'Creator posts use Rust pagination');
		await bridge.subscriptions.command({ action: 'read', ids: [page.entries[0].id], read: true });
		assert((await bridge.subscriptions.getEntries({ subscriptionId: ids.creator, page: 1, pageSize: 40, unread: true })).total === 64, 'Read state persists in SQLite');
		await bridge.subscriptions.command({ action: 'preferences-patch', patch: { theme: 'night' } });
		assert((await bridge.subscriptions.getState()).preferences.theme === 'night', 'Preferences retain patch semantics');
		const metadata = await bridge.metadata.getState();
		assert(metadata.tasks.length === 1, 'Validated Rust metadata snapshot');
		const saved = await bridge.library.save({ taskId: ids.query, code: 'SONE-614', replace: false });
		assert(saved.ok, `Save collection: ${saved.message ?? ''}`);
		const library = await bridge.library.getState();
		assert(library.works.length === 1 && !!(await bridge.library.getWork(saved.id)), 'Collection summary and full record validate');
		const usage = await bridge.storage.usage();
		await bridge.storage.clear();
		assert(usage.collectionBytes > 0 && (await bridge.storage.usage()).collectionBytes >= usage.collectionBytes, 'Clearing cache preserves collection and avatars');
		const image = new Image();
		image.src = `nectisse-cover://avatars/${ids.avatar}`;
		await until(() => image.complete, 'native image scheme');
		assert(image.naturalWidth > 0, 'Custom image protocol serves validated cached pixels');
		assert((await bridge.diagnostics.getReport()).environment.tauriVersion === '2.12.5', 'Native diagnostics expose Tauri version');
		await click('演员');
		await until(() => button('查看演员样本的主页'), 'actor card');
		await snapshot('actors');
		await click('管理');
		assert(!!(await until(() => document.querySelector('.subscription-cards'), 'actor management list')), 'Actor management list renders');
		await click('浏览');
		await click('查看演员样本的主页');
		await until(() => document.querySelector('[aria-label="演员资料"]'), 'actor profile');
		await click('创作者');
		await until(() => button('查看创作手记的主页'), 'creator card');
		await snapshot('creators');
		await click('查看创作手记的主页');
		await until(() => document.querySelector('[aria-label="创作者资料"]'), 'creator profile');
		await snapshot('profile');
		assert(!!document.querySelector('.collected-entries'), 'Creator stream renders with shared profile UI');
		await until(() => {
			const scroll = document.querySelector('.page-scroll');
			scroll?.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' });
			return document.querySelectorAll('.real-feed-entry').length === 65;
		}, 'creator infinite scrolling');
		const postIds = [...document.querySelectorAll('.real-feed-entry')].map((el) => el.dataset.postId);
		assert(new Set(postIds).size === 65, 'Native scrolling loads every creator post once');

		await click('创作者');
		await click('查看海岸日记的主页');
		const galleryCard = await until(() => document.querySelector('.real-feed-entry .feed-item-thumbnail'), 'multi-image post');
		galleryCard.click();
		await until(() => document.querySelectorAll('.entry-gallery-thumbnail').length === 2, 'all post images');
		assert(!!document.querySelector('.entry-dialog-footer time') && !document.querySelector('.entry-dialog-facts'), 'Post time stays in the footer without redundant metadata');
		assert(!document.querySelector('.entry-dialog-title:not(.sr-only)'), 'X posts do not repeat a synthetic title');
		await click('查看第 2 张图片');
		await until(() => {
			const image = document.querySelector('.entry-gallery-picture img');
			return image?.naturalWidth > 0 && image.src.includes('index=1');
		}, 'second image through native protocol');
		assert(document.querySelector('.entry-gallery-count').textContent.trim() === '2 / 2', 'Gallery selects the second cached image');
		await snapshot('post');
		await click('查看第 2 张大图');
		const viewer = await until(() => document.querySelector('.entry-image-viewer'), 'full image viewer');
		await until(() => document.querySelector('.entry-image-viewer img')?.naturalWidth > 0, 'full resolution image');
		viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
		assert(
			await until(() => document.querySelector('.entry-image-viewer-position')?.textContent.trim() === '1 / 2', 'keyboard gallery navigation'),
			'Keyboard arrows change the full-size image',
		);
		await click('原始大小');
		assert(!!document.querySelector('.entry-image-viewer-stage.is-zoomed'), 'Full image viewer supports original size');
		await click('适合窗口');
		await snapshot('image-viewer');
		viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
		await until(() => !document.querySelector('.entry-image-viewer'), 'escape full image');
		assert(!!document.querySelector('.entry-dialog'), 'Esc returns from the image viewer to post details');
		await bridge.subscriptions.command({ action: 'preferences-patch', patch: { theme: 'cream' } });
		await until(() => document.documentElement.dataset.theme === 'cream', 'light post theme');
		await snapshot('post-cream');
		await click('完成阅读');
		await until(() => !document.querySelector('.entry-dialog'), 'close post');
		await bridge.subscriptions.command({ action: 'preferences-patch', patch: { theme: 'night' } });

		await click('设置');
		await snapshot('settings');
		await click('外观与应用');
		const appVersion = (await bridge.diagnostics.getReport()).environment.appVersion;
		assert(await until(() => document.body.textContent.includes(`Nectisse ${appVersion}`), 'settings version'), 'Settings displays the actual application version');
		await click('打开演示');
		await until(() => document.querySelector('[aria-label="示例数据模式"]'), 'demo mode');
		await snapshot('demo');
		await click('返回真实工作区');
		await until(() => !document.querySelector('[aria-label="示例数据模式"]'), 'real workspace');
		assert((await bridge.subscriptions.getState()).subscriptions.length === 3, 'Demo swap leaves real data intact');
		assert(document.documentElement.scrollWidth <= innerWidth, 'WKWebView layout fits native window');
		await invoke('smoke_report', { report: { success: true, checks, userAgent: navigator.userAgent } });
	} catch (error) {
		await invoke('smoke_report', {
			report: {
				success: false,
				checks,
				error: String(error),
				text: document.body.innerText.slice(-6000),
				buttons: [...document.querySelectorAll('button')].map((el) => el.getAttribute('aria-label') || el.textContent.trim()),
			},
		});
	}
})();
