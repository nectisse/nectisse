import { queryRequestSchema, type QueryPlan, type QueryRequest, type SourceId } from '@shared/metadata';
import { METADATA_IDS, SOURCE_BY_ID } from '@shared/sources';

const standardCode = /^(?:\d{3})?[A-Z]{2,8}-\d{2,5}$/;

export function normalizeCode(raw: string): string {
	const value = raw.trim().toUpperCase();
	const fc2 = /^FC2(?:[-_. ]?PPV)?[-_. ]?(\d{5,})$/.exec(value);
	if (fc2) {
		return `FC2-PPV-${fc2[1]}`;
	}
	const standard = /^(\d{3})?([A-Z]{2,8})[-_ ]?(\d{2,5})$/.exec(value);
	return standard ? `${standard[1] ?? ''}${standard[2]}-${Number(standard[3]).toString().padStart(3, '0')}` : '';
}

export function codeFromCid(cid: string): string {
	const match = /^(?:h_\d+)?(?:(\d{1,3}))?([a-z]{2,8})(\d{2,5})$/i.exec(cid);
	return match ? normalizeCode(`${match[1] ?? ''}${match[2]}-${match[3]}`) : '';
}

export function planQuery(value: QueryRequest): QueryPlan {
	const request = queryRequestSchema.parse(value);
	let query = request.query;
	let code = normalizeCode(query);
	let contentId = '';
	let specific: SourceId | undefined;
	if (/^[a-z][\w+.-]*:\/\//i.test(query)) {
		const url = new URL(query);
		if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
			throw new Error('只支持不含登录信息的 HTTPS 原站链接');
		}
		const host = url.hostname.toLowerCase();
		if (['adult.contents.fc2.com', 'contents.fc2.com'].includes(host)) {
			const id = /^\/article\/(\d{5,})\/?$/.exec(url.pathname)?.[1];
			if (!id) {
				throw new Error('请输入 FC2 作品商品页链接，不是卖家或列表页');
			}
			code = `FC2-PPV-${id}`;
		} else if (host === 'fc2ppv-db.com') {
			const id = /^\/(?:ja\/|en\/)?videos\/(\d{5,})\/?$/.exec(url.pathname)?.[1];
			if (!id) {
				throw new Error('请输入 FC2PPV-DB 的作品页链接');
			}
			code = `FC2-PPV-${id}`;
			specific = 'fc2ppvdb';
		} else if (['video.dmm.co.jp', 'www.dmm.co.jp', 'www.dmm.com', 'dmm.co.jp', 'dmm.com'].includes(host)) {
			contentId = url.searchParams.get('id') ?? /\/(?:cid|id)=([a-zA-Z0-9_]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? '';
			if (!/^[a-zA-Z0-9_]{2,100}$/.test(contentId)) {
				throw new Error('未识别 DMM 商品身份，请使用含 id 或 cid 的作品链接');
			}
			code = codeFromCid(contentId);
		} else if (['r18.dev', 'www.r18.dev'].includes(host)) {
			const match = /\/(dvd_id|combined)=([^/]+)(?:\/|$)/.exec(url.pathname);
			if (!match) {
				throw new Error('未识别 r18.dev 的作品身份');
			}
			if (match[1] === 'dvd_id') {
				code = normalizeCode(decodeURIComponent(match[2]!));
			} else {
				contentId = match[2]!;
				code = codeFromCid(contentId);
			}
		} else if (host === 'www.1pondo.tv' || host === '1pondo.tv') {
			const id = /^\/movies\/(\d{6}_\d{2,4})\/?$/.exec(url.pathname)?.[1];
			if (!id) {
				throw new Error('请输入一本道的单片主页链接');
			}
			code = id;
			specific = '1pondo';
		} else if (host === 'www.k-mib.com' || host === 'k-mib.com') {
			const idx = url.searchParams.get('idx');
			if (url.pathname !== '/video/video-view.php' || !idx || !/^\d+$/.test(idx)) {
				throw new Error('请输入 K-MIB 单片链接');
			}
			if (!request.sources.includes('kmib')) {
				throw new Error('请先选择 K-MIB 来源');
			}
			const sourceUrl = `https://www.k-mib.com/video/video-view.php?idx=${idx}`;
			return { kind: 'url', query: sourceUrl, code: '', contentId: idx, sourceUrl, sources: ['kmib'] };
		} else if (host === 'javdb.com' && /^\/v\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
			if (!request.sources.includes('javdb')) {
				throw new Error('请先选择 JavDB 来源');
			}
			const sourceUrl = `https://javdb.com${url.pathname.replace(/\/$/, '')}`;
			return { kind: 'url', query: sourceUrl, code: '', contentId: '', sourceUrl, sources: ['javdb'] };
		} else {
			specific = METADATA_IDS.find((id) => SOURCE_BY_ID[id].domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
			if (!specific) {
				throw new Error('未识别此站点，请使用已登记来源的作品编号或原站链接');
			}

			const component = decodeURIComponent(url.pathname)
				.split('/')
				.filter(Boolean)
				.reverse()
				.find((part) => normalizeCode(part));

			code = component ? normalizeCode(component) : '';
			if (!code) {
				throw new Error('链接中没有可靠的作品编号，请改用编号；K-MIB 与 JavDB 支持单片原生链接');
			}
		}
		if (!code) {
			throw new Error('该链接没有可可靠识别的作品编号，请改用编号查询');
		}
		query = code; // 不把无关查询参数或潜在 token 写入查询记录。
	}
	if (/^FC2/i.test(query) && !code) {
		throw new Error('FC2 分段编号或不完整编号不能按整部商品查询');
	}
	const dated = /^\d{6}[-_]\d{2,4}$/.test(query);
	if (dated && !code) {
		if (request.sources.length !== 1 || request.sources[0] !== '1pondo') {
			throw new Error('日期式编号需要发行方证据：请粘贴一本道原站链接，或仅选择一本道再查询');
		}
		code = query.replace('-', '_');
		specific = '1pondo';
	}
	if (!code && /^[a-zA-Z0-9 _-]+$/.test(query) && /\d/.test(query) && !/\s\w+\s/.test(query)) {
		throw new Error('未识别此编号，请检查完整写法或使用支持的原站链接');
	}
	const kind = code ? 'code' : 'title';
	if (code && !code.startsWith('FC2') && !standardCode.test(code) && !dated) {
		throw new Error('当前来源不支持此编号格式');
	}
	if (kind === 'title' && query.length > 200) {
		throw new Error('标题最多输入 200 个字符');
	}
	const family = code.startsWith('FC2') ? 'fc2' : dated ? 'dated' : 'standard';
	const allowed: SourceId[] = kind === 'title' ? ['dmm'] : specific ? [specific] : METADATA_IDS.filter((id) => id !== 'kmib' && SOURCE_BY_ID[id].families.includes(family));
	const sources = allowed.filter((source) => request.sources.includes(source));

	if (!sources.length) {
		throw new Error(kind === 'title' ? '标题查询请启用 DMM 来源' : '请在资料来源中选择支持此作品类型的来源，并在设置中启用');
	}
	return { kind, query, code, contentId, sources };
}
