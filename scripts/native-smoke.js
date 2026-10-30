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
		const pageScroll = document.querySelector('.page-scroll');
		pageScroll.scrollTop = Math.min(120, pageScroll.scrollHeight - pageScroll.clientHeight);
		const scrollBeforePreview = pageScroll.scrollTop;
		galleryCard.click();
		let viewer = await until(() => document.querySelector('.entry-image-viewer'), 'direct image preview');
		assert(!document.querySelector('.entry-dialog'), 'Clicking a post cover opens its image preview directly');
		assert(document.querySelector('.entry-image-viewer-position').textContent.trim() === '1 / 3', 'Image preview starts at the first of all three pictures');
		assert(
			getComputedStyle(viewer).backgroundColor === 'rgba(0, 0, 0, 0)' && !!document.querySelector('.entry-image-overlay'),
			'Image viewer uses a translucent full-window overlay',
		);
		assert(button('上一张图片').disabled, 'The first picture has no previous picture');
		await click('下一张图片');
		await until(() => {
			const image = document.querySelector('.entry-image-viewer-picture img');
			return image?.naturalWidth > 0 && image.src.includes('index=1');
		}, 'second original through native cache');
		assert(document.querySelector('.entry-image-viewer-position').textContent.trim() === '2 / 3', 'Side arrows switch to the second original image');
		await snapshot('image-viewer');
		await click('保存当前图片');
		assert(await until(() => invoke('smoke_image_saved', { id: ids.gallery, index: 1 }), 'save the selected original'), 'Saving writes the currently selected original bytes');
		assert(
			await until(() => document.querySelector('[data-sonner-toast]')?.textContent.includes('图片已保存'), 'saved picture feedback'),
			'Successful saves show confirmation',
		);
		await click('关闭提示');
		viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
		await until(() => document.querySelector('.entry-image-viewer-position')?.textContent.trim() === '3 / 3', 'keyboard last image');
		assert(button('下一张图片').disabled, 'The last picture has no next picture');
		viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
		await until(() => !document.querySelector('.entry-image-viewer'), 'escape image preview');
		assert(!document.querySelector('.entry-dialog'), 'Esc returns directly to the post list');
		assert(Math.abs(pageScroll.scrollTop - scrollBeforePreview) < 1, 'Closing the image preview retains the list scroll position');
		assert(document.activeElement === galleryCard, 'Closing the image preview restores focus to its cover');

		const summary = document.querySelector('.real-feed-entry .feed-item-summary');
		summary.click();
		await until(() => document.querySelectorAll('.entry-detail-media button').length === 3, 'post text and compact photo grid');
		assert(!!document.querySelector('.entry-dialog-footer time') && !document.querySelector('.entry-dialog-facts'), 'Post time stays in the footer without redundant metadata');
		assert(!document.querySelector('.entry-dialog-title:not(.sr-only)'), 'X posts do not repeat a synthetic title');
		assert(!document.querySelector('.entry-gallery-expand'), 'The separate view-large-image entry has been removed');
		await snapshot('post');
		await click('预览第 3 张图片');
		viewer = await until(() => document.querySelector('.entry-image-viewer'), 'preview from text details');
		assert(document.querySelector('.entry-image-viewer-position').textContent.trim() === '3 / 3', 'Clicking a detail thumbnail opens that exact picture');
		assert(
			document.querySelectorAll('[data-slot="dialog-overlay"]').length === 1 && !document.querySelector('.entry-dialog'),
			'Text details and photo previews share one dialog',
		);
		await bridge.subscriptions.command({ action: 'preferences-patch', patch: { theme: 'cream' } });
		await until(() => document.documentElement.dataset.theme === 'cream', 'light image preview theme');
		await snapshot('image-viewer-cream');
		await click('关闭图片预览');
		await until(() => !document.querySelector('.entry-image-viewer'), 'close image preview');
		summary.click();
		await until(() => document.querySelector('.entry-dialog'), 'light post text');
		await snapshot('post-cream');
		await click('完成阅读');
		await until(() => !document.querySelector('.entry-dialog'), 'close post');
		await bridge.subscriptions.command({ action: 'preferences-patch', patch: { theme: 'night' } });

		for (let index = 1; index < 14; index++) {
			const saved = await bridge.library.save({ taskId: ids.query, code: `SONE-${614 + index}`, replace: false });
			assert(saved.ok, `Save photo wall fixture ${index + 1}`);
		}
		await click('作品收藏');
		await click('照片墙');
		const wall = await until(() => document.querySelector('.collection-wall-viewport'), 'collection wall');
		const world = wall.querySelector('.collection-wall-world');
		const centered = async (count) =>
			until(() => {
				const tiles = [...wall.querySelectorAll('.collection-wall-tile')];
				if (tiles.length !== count) {
					return false;
				}
				const rects = tiles.map((tile) => tile.getBoundingClientRect());
				const viewport = wall.getBoundingClientRect();
				const left = Math.min(...rects.map((rect) => rect.left));
				const right = Math.max(...rects.map((rect) => rect.right));
				const top = Math.min(...rects.map((rect) => rect.top));
				const bottom = Math.max(...rects.map((rect) => rect.bottom));
				return (
					Math.abs((left + right) / 2 - (viewport.left + viewport.width / 2)) < 1 &&
					Math.abs((top + bottom) / 2 - (viewport.top + (viewport.height - 8) / 2)) < 1 &&
					left >= viewport.left + 23 &&
					right <= viewport.right - 23 &&
					top >= viewport.top + 71 &&
					bottom <= viewport.bottom - 79
				);
			}, `centered photo wall with ${count} works`);

		assert(await centered(14), 'All 14 wall covers fit in a centered initial view with toolbar clearance');
		const wallTiles = [...wall.querySelectorAll('.collection-wall-tile')];
		const extent = {
			width: Math.max(...wallTiles.map((tile) => parseFloat(tile.style.left) + parseFloat(tile.style.width))),
			height: Math.max(...wallTiles.map((tile) => parseFloat(tile.style.top) + parseFloat(tile.style.height))),
		};
		const intervals = wallTiles.map((tile) => [parseFloat(tile.style.left), parseFloat(tile.style.left) + parseFloat(tile.style.width)]).sort((a, b) => a[0] - b[0]);
		let occupied = 0;
		let largestGap = 0;
		for (const [left, right] of intervals) {
			largestGap = Math.max(largestGap, left - occupied);
			occupied = Math.max(occupied, right);
		}
		assert(largestGap <= 6, 'Partial collage blocks remain adjacent without a central empty band');
		await until(() => [...wall.querySelectorAll('img')].every((image) => image.complete && image.naturalWidth > 0), 'wall cover pixels');
		await snapshot('wall');
		const initialScale = new DOMMatrix(getComputedStyle(world).transform).a;
		await click('放大照片墙');
		await click('放大照片墙');
		wall.dispatchEvent(new WheelEvent('wheel', { deltaX: 1e6, deltaY: 1e6, bubbles: true, cancelable: true }));
		assert(
			await until(() => {
				const matrix = new DOMMatrix(getComputedStyle(world).transform);
				return matrix.a > initialScale * 1.3 && Math.abs(matrix.m41 + extent.width * matrix.a - wall.clientWidth + 24) < 1;
			}, 'right wall boundary'),
			'Panning a zoomed wall stops at its padded right boundary',
		);
		await click('重置照片墙位置');
		assert(await centered(14), 'Reset restores a centered wall and fits the collection again');
		await click('搜索照片墙');
		const searchWall = async (value) => {
			const input = document.querySelector('input[aria-label="搜索照片墙"]');
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};

		await searchWall('SONE-614');
		assert(await centered(1), 'A single filtered work recenters without keeping the previous pan');
		await snapshot('wall-one');
		await searchWall('双张照片墙样本');
		assert(await centered(2), 'Two filtered works stay together in the center');
		await snapshot('wall-two');
		await searchWall('missing-wall-fixture');
		assert(await until(() => document.body.textContent.includes('没有匹配的收藏'), 'empty photo wall'), 'Empty wall filter remains recoverable');
		await click('清除照片墙筛选');
		assert(await centered(14), 'Clearing the filter restores all covers and their centered view');
		await click('返回收藏');

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
