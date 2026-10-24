"""JavTao 公开 HTML：作品、演员目录与作品页磁链共用身份校验。"""
from __future__ import annotations

import re
import json
import unicodedata
from datetime import date
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from bs4 import BeautifulSoup
from peach_core.catalog_rules import normalise_code_key, same_release_code, _jav_code_pattern
from .metadata.base import Cancelled, FailureReason, Page, SiteConfig, SiteRecord, SiteSource, SourceFailure
from .metadata.network import allowed_url

ROOT = 'https://javtao.com'
CONFIG = SiteConfig('javtao', 'JavTao', 'nectisse-javtao-html', ROOT, ('javtao.com',), 'community')
ACTOR_REF = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
WORK_PATH = re.compile(r'/[a-z0-9][a-z0-9_-]{1,95}')
CODE = re.compile(r'[A-Z0-9]+(?:[-_][A-Z0-9]+)*')
MAX_ACTOR_WORKS = 500


def clean(value, limit=1000):
    return re.sub(r'\s+', ' ', str(value or '')).strip()[:limit]


def soup_for(page):
    soup = BeautifulSoup(page.text, 'html.parser')
    if not soup.find('main') or not soup.title:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 未返回有效页面，不能视为没有结果')
    return soup


def actor_url(ref):
    if not isinstance(ref, str) or len(ref) > 128 or not ACTOR_REF.fullmatch(ref):
        raise SourceFailure(FailureReason.UNSUPPORTED, 'JavTao 演员主页身份不正确')
    return f'{ROOT}/actress/{ref}'


def actor_ref(value):
    if not allowed_url(value, ('javtao.com',)):
        raise SourceFailure(FailureReason.UNSUPPORTED, '请使用 JavTao 的 HTTPS 演员主页')
    parsed = urlsplit(value)
    match = re.fullmatch(r'/actress/([a-z0-9-]+)/?', parsed.path)
    if not match or parsed.query or parsed.fragment:
        raise SourceFailure(FailureReason.UNSUPPORTED, '需要 JavTao 演员主页，不是作品或搜索页')
    actor_url(match[1])
    return match[1]


def work_url(value):
    url = urljoin(ROOT + '/', str(value or ''))
    if not allowed_url(url, ('javtao.com',)):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 作品链接超出来源范围')
    parsed = urlsplit(url)
    path = parsed.path.rstrip('/')
    if not WORK_PATH.fullmatch(path) or not re.search(r'\d', path) or parsed.query or parsed.fragment:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 未返回可核对的作品链接')
    return ROOT + path


def fetch(session, url):
    failures = getattr(session, 'failures', [])
    previous = len(failures)
    for attempt in range(2):
        try:
            page = session.get(url, config=CONFIG)
            soup_for(page)
            # 只清除已重试成功的传输故障；请求许可和次数仍逐次计入。
            del failures[previous:]
            return page
        except SourceFailure as error:
            if attempt or error.reason not in {FailureReason.NETWORK, FailureReason.TIMEOUT}:
                raise


def fields_of(soup):
    return {row.dt.get_text(' ', strip=True): row.dd for row in soup.select('.info .meta .r') if row.dt and row.dd}


def parse_work(page, expected=''):
    soup = soup_for(page)
    fields = fields_of(soup)
    shown = clean(fields['番号'].get_text(' ', strip=True), 64).upper() if '番号' in fields else ''
    if not CODE.fullmatch(shown):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 作品页缺少可核对的编号')
    if expected and not same_release_code(expected, shown):
        raise SourceFailure(FailureReason.NOT_FOUND, 'JavTao 返回的作品编号与请求不一致')
    url = work_url(page.url)
    heading = soup.select_one('.info h1')
    if heading is None:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 作品页缺少标题')
    title = clean(heading.get_text(' ', strip=True))
    title = re.sub(r'^' + re.escape(shown) + r'\s*', '', title, count=1, flags=re.I)
    cover = soup.select_one('.cov a[href]')
    image = urljoin(ROOT + '/', str(cover.get('href') or '')) if cover else ''
    if image and (not allowed_url(image, CONFIG.domains) or not urlsplit(image).path.startswith('/upload-img/')):
        image = ''
    performers = []
    for link in fields.get('女优', soup.new_tag('dd')).select('a[href]'):
        try:
            ref = actor_ref(urljoin(ROOT + '/', link['href']))
        except SourceFailure:
            continue
        name = clean(link.get_text(' ', strip=True), 100)
        if name and not any(person['external_id'] == ref for person in performers):
            performers.append({'japanese_name': name, 'external_id': ref})
    value = lambda key: clean(fields[key].get_text(' ', strip=True), 500) if key in fields else ''
    tags = list(dict.fromkeys(clean(item.get_text(' ', strip=True), 100) for item in soup.select('.info .chips a, .info .chips span')))
    runtime = re.search(r'\d+', value('时长'))
    return SiteRecord(
        source='javtao', provenance=CONFIG.provider, code=normalise_code_key(shown), source_url=url, title=title,
        performers=tuple(performers), studio=value('片商'), label=value('发行商'), director=value('导演'),
        release_date=value('发行日期'), runtime=int(runtime[0]) if runtime else None, tags=tuple(tag for tag in tags if tag),
        cover_urls=(image,) if image else (), extra={'content_id': urlsplit(url).path[1:]},
    )


def cards_of(soup):
    grid = soup.select_one('main section.grid')
    if grid is None:
        main = soup.find('main')
        if main and re.search(r'未找到|没有找到|暂无|没有匹配', main.get_text(' ', strip=True)):
            return []
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 列表结构不匹配，不能视为没有结果')
    result = []
    seen = set()
    for card in grid.select(':scope > a.card')[:MAX_ACTOR_WORKS + 1]:
        code = card.select_one('.code')
        title = card.select_one('h2')
        if code is None or title is None:
            raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 作品卡片缺少编号或标题')
        url = work_url(card.get('href'))
        shown = clean(code.get_text(' ', strip=True), 64).upper()
        if not CODE.fullmatch(shown):
            raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 作品卡片编号不正确')
        if url in seen:
            continue
        seen.add(url)
        image = card.select_one('img[src]')
        image_url = urljoin(ROOT + '/', str(image.get('src') or '')) if image else ''
        stamp = card.select_one('.dt')
        actor = card.select_one('.act')
        released = clean(stamp.get_text(' ', strip=True), 32) if stamp else ''
        try:
            released = date.fromisoformat(released).isoformat()
        except ValueError:
            released = ''
        result.append({'url': url, 'code': normalise_code_key(shown), 'title': clean(title.get_text(' ', strip=True)), 'date': released, 'actor': clean(actor.get_text(' ', strip=True), 200) if actor else '',
                       'image': image_url if allowed_url(image_url, CONFIG.domains) and urlsplit(image_url).path.startswith('/upload-img/') else ''})
    return result


def fetch_work(session, code):
    page = fetch(session, ROOT + '/search?' + urlencode({'query': code}))
    matches = [row for row in cards_of(soup_for(page)) if same_release_code(row['code'], code)]
    urls = list(dict.fromkeys(row['url'] for row in matches))
    if not urls:
        raise SourceFailure(FailureReason.NOT_FOUND, 'JavTao 未找到与编号一致的作品')
    if len(urls) != 1:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 返回多个同编号版本，请使用具体作品链接')
    page = fetch(session, urls[0])
    parse_work(page, code)
    return page


class JavTaoSource(SiteSource):
    DEFAULT = CONFIG

    def fetch(self, code, *, session):
        return fetch_work(session, code)

    def parse(self, page, code):
        return parse_work(page, code)


def profile(page, ref):
    soup = soup_for(page)
    if actor_ref(page.url) != ref:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 返回另一位演员的主页')
    name = soup.select_one('main .hero h1')
    if not name or not clean(name.get_text(' ', strip=True), 200):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 演员页缺少姓名')
    rows = cards_of(soup)
    subtitle = soup.select_one('main .hero .sub, main .hero p')
    match = re.search(r'共收录\s*(\d+)\s*部', subtitle.get_text(' ', strip=True) if subtitle else '')
    total = int(match[1]) if match else len(rows)
    more = bool(soup.select_one('a[rel="next"], a.pagination-next[href]'))
    over_budget = len(soup.select('main section.grid > a.card')) > MAX_ACTOR_WORKS
    return clean(name.get_text(' ', strip=True), 200), rows[:MAX_ACTOR_WORKS], more or total > len(rows) or over_budget


def candidate(ref, name, aliases=()):
    return {'provider': 'javtao', 'ref': ref, 'name': name, 'url': actor_url(ref), 'aliases': list(aliases)[:12],
            'recordType': '演员目录', 'bio': '', 'avatarUrl': '', 'evidence': 'JavTao 目录或主页提供的原生链接；来源未提供演员头像'}


def lookup(params, session):
    query = clean(params.get('query'), 500)
    if '://' in query:
        ref = actor_ref(query)
        name, _, _ = profile(fetch(session, actor_url(ref)), ref)
        return [candidate(ref, name)]
    if not 1 <= len(query) <= 100:
        raise SourceFailure(FailureReason.UNSUPPORTED, '演员名需要 1 至 100 个字符，或提供 JavTao 演员主页')
    soup = soup_for(fetch(session, ROOT + '/actress'))
    links = soup.select('main .tag-cloud a.ag-dedup[href]')
    if not links:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 演员目录未返回可核对的身份')
    normalize = lambda name: re.sub(r'\s+', '', unicodedata.normalize('NFKC', name)).casefold()
    names = {}
    for link in links[:5000]:
        try:
            ref = actor_ref(urljoin(ROOT + '/', link['href']))
        except SourceFailure:
            continue
        name = clean(link.get_text(' ', strip=True), 200)
        if name and name not in names.setdefault(ref, []):
            names[ref].append(name)
    key = normalize(query)
    exact = [(ref, aliases) for ref, aliases in names.items() if any(normalize(name) == key for name in aliases)]
    matches = exact or [(ref, aliases) for ref, aliases in names.items() if len(key) >= 2 and any(key in normalize(name) for name in aliases)]
    if matches:
        return [candidate(ref, aliases[0], aliases[1:]) for ref, aliases in matches[:8]]
    # 目录不是完整演员索引，未命中时仅核对少量搜索作品中的实际演员链接。
    rows = cards_of(soup_for(fetch(session, ROOT + '/search?' + urlencode({'query': query}))))
    rows.sort(key=lambda row: normalize(row['actor']) != key)
    found = {}
    for row in rows[:3]:
        record = parse_work(fetch(session, row['url']), row['code'])
        people = [person for person in record.performers if normalize(person['japanese_name']) == key]
        people = people or [person for person in record.performers if len(key) >= 2 and key in normalize(person['japanese_name'])]
        for person in people:
            item = candidate(person['external_id'], person['japanese_name'])
            item['evidence'] = 'JavTao 搜索作品的完整演员字段提供原生主页链接；请核对身份'
            found[item['ref']] = item
        if found:
            break
    return list(found.values())[:8]


def check(params, session, publish):
    ref = str(params.get('ref') or '')
    name, rows, truncated = profile(fetch(session, actor_url(ref)), ref)
    seen = set(params.get('seen', [])[:500])
    for row in rows:
        if getattr(session, 'cancelled', None) is not None and session.cancelled.is_set():
            raise Cancelled()
        key = urlsplit(row['url']).path
        # 来源顺序不可靠，扫描整页；已知条目不能提前结束检查。
        if key in seen:
            continue
        publish({'externalId': key, 'title': row['title'], 'summary': '', 'author': name, 'publishedAt': row['date'],
                 'publishedPrecision': 'date' if row['date'] else 'unknown', 'url': row['url'], 'thumbnailUrl': row['image'],
                 'code': row['code'], 'restricted': False, 'partial': False})
    return {'coverage': f'{"初次收录：" if not params.get("initialized") else ""}已检查当前演员页 {len(rows)} 部作品；未扩展其他页面或历史',
            'gap': truncated, 'pages': 1, 'warnings': ['当前页超过条目预算或未完整返回，暂不能确认更新覆盖范围'] if truncated else [], 'avatarUrl': ''}


def parse_magnets(page, code, limit):
    record = parse_work(page, code)
    table = soup_for(page).select_one('section#magnets table.mag-table')
    if table is None:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 未返回磁链表格')
    items = []
    seen = set()
    invalid = 0
    fragment = re.escape(code) if re.fullmatch(r'\d{6}[-_]\d{2,4}', code) else _jav_code_pattern(code) or re.escape(code)
    identity = re.compile(r'(?<![A-Z0-9])(?:' + fragment + r')(?![A-Z0-9])', re.I)
    for row in table.select('tr')[:101]:
        if not row.find('td'):
            continue
        link = row.select_one('a.mag[href]')
        name = row.select_one('.mn')
        if not link or not name:
            invalid += 1
            continue
        title = clean(name.get_text(' ', strip=True), 300)
        uri = str(link.get('href') or '')
        values = parse_qs(urlsplit(uri).query)
        hashes = values.get('xt', [])
        if not uri.startswith('magnet:?') or len(hashes) != 1 or not re.fullmatch(r'urn:btih:[a-fA-F0-9]{40}', hashes[0], re.I) or not identity.search(title):
            invalid += 1
            continue
        info_hash = hashes[0].rsplit(':', 1)[1].lower()
        if info_hash in seen:
            continue
        seen.add(info_hash)
        if len(uri) > 2400 or len(uri.encode()) > 2400:
            uri = 'magnet:?' + urlencode({'xt': 'urn:btih:' + info_hash, 'dn': title[:150]})
        size = row.select_one('.ms')
        stamp = row.select_one('.md')
        shared = clean(stamp.get_text(' ', strip=True), 32) if stamp else ''
        try:
            shared = date.fromisoformat(shared).isoformat()
        except ValueError:
            shared = ''
        item = {'id': info_hash, 'title': title, 'magnet': uri, 'url': record.source_url, 'size': clean(size.get_text(' ', strip=True), 40) if size else '',
                'uploadedAt': None, 'sharedAt': shared, 'seeders': None, 'leechers': None, 'completed': None}
        if len(json.dumps(items + [item], ensure_ascii=False).encode()) > 58000:
            break
        items.append(item)
        if len(items) >= limit:
            break
    if invalid and not items and not re.search(r'暂无|没有|未找到', table.get_text(' ', strip=True)):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'JavTao 磁链表格结构不匹配')
    return items
