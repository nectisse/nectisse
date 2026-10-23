// 从只读参考快照提取纯解析模块；不导入 Peach 的服务、账本或资源管线。
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const upstream = new URL('../ref/peach/src/peach/', import.meta.url);
const vendor = new URL('../python/vendor/peach_core/', import.meta.url);
const rows = [];
async function extract(name, target, transform = value => value) {
	const raw = await readFile(new URL(name, upstream), 'utf8');
	const value = transform(raw);
	await writeFile(new URL(target, vendor), value);
	rows.push({ source: name, target, upstreamSha256: createHash('sha256').update(raw).digest('hex'), extractedSha256: createHash('sha256').update(value).digest('hex') });
}
await extract('fanbox.py', 'fanbox.py');
await extract('javdb.py', 'javdb.py', value => value.replace('from .social_links import name_key', 'from .follow_primitives import name_key'));
await extract('social_links.py', 'follow_primitives.py', value => '"""Peach 姓名比较片段。"""\nimport re\nimport unicodedata\n\n' + value.slice(value.indexOf('def name_key('), value.indexOf('\n\n', value.indexOf('    return re.sub', value.indexOf('def name_key(')))) + '\n');
await extract('feeds.py', 'actor_feed.py', value => {
	const start = value.indexOf('_TOKEN ='); const boundary = value.indexOf('#: 合集的标题记号'); const functions = value.indexOf('def stamp('); const end = value.indexOf('def solo_works_url(');
	if (start < 0 || boundary <= start || functions < 0 || end <= functions) throw new Error('Peach Feed 解析片段边界变化，请核对参考实现');
	return '"""Peach JavDB 演员页纯解析片段，无数据库和网络副作用。"""\nfrom __future__ import annotations\nimport re\nfrom dataclasses import dataclass\nfrom datetime import datetime, timezone\nfrom urllib.parse import urljoin\nfrom .catalog_rules import release_code_from_text\nMAX_ENTRIES = 200\n' + value.slice(start, boundary) + '\n' + value.slice(functions, end);
});
await extract('follow_sources.py', 'official_posts.py', value => {
	const section = (start, end) => { const a = value.indexOf(start); const b = value.indexOf(end, a + start.length); if (a < 0 || b < 0) throw new Error('官方动态纯解析提取边界变化'); return value.slice(a, b); };
	return '"""Peach Patreon 与 SubscribeStar 公开卡片解析。网络由 Nectisse 注入。"""\nfrom __future__ import annotations\nimport re\nimport urllib.parse\nfrom dataclasses import dataclass, field\nfrom datetime import datetime, timedelta, timezone\nfrom typing import Mapping\nfrom bs4 import BeautifulSoup\nfrom nectisse_worker.follow_official_support import _BaseConnector, ParsedSource, FollowSourceError, plain_text\n\n_DIRECT_CREATOR_RE = re.compile(r"^/([A-Za-z0-9_-]{1,80})(?:/|$)")\n\n' + section('@dataclass(frozen=True)\nclass FollowCandidate:', 'def published_stamp(') + section('def _iso_utc(', 'def _dims_extra(') + section('def _iso_from_text(', '_DURATION_RE =') + section('_SLUG_TAIL_RE =', 'class _BaseConnector:') + section('def _visible_post_image(', 'class SimpCityConnector(');
});
await writeFile(new URL('../follow-extraction.json', vendor), JSON.stringify({ peachVersion: '0.46.1', rows }, null, 2) + '\n');
console.log('已提取 FANBOX 正文、JavDB 演员身份与目录解析。');
