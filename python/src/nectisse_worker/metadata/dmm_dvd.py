"""配信目录缺片时的 DVD 通贩兜底；只接收核对过的普通版商品。"""
import re
from datetime import date
from urllib.parse import quote, urljoin, urlsplit

from bs4 import BeautifulSoup
from peach_core.sources.dmm import DMM, matching_cids

from .base import FailureReason, SiteRecord, SourceFailure


ORIGIN = 'https://www.dmm.co.jp'
DETAIL_PATH = '/mono/dvd/-/detail/=/cid={cid}/'
SPECIAL_EDITION = re.compile(r'ブルーレイ|Blu-?ray|\bBOD\b|受注生産|復刻版|数量限定|FANZA限定|特典付き|生写真.*(?:付き|セット)', re.I)


def dvd_cid(url):
    try:
        parsed = urlsplit(url)
    except ValueError:
        return ''
    if parsed.scheme != 'https' or parsed.netloc not in {'www.dmm.co.jp', 'www.dmm.com'}:
        return ''
    match = re.fullmatch(r'/mono/dvd/-/detail/=/cid=([a-zA-Z0-9_]+)/?', parsed.path)
    return match[1].lower() if match else ''


def ordinary_cid(code, cid):
    # 不接受特典前缀、BD/AI 等后缀；复用 Peach 对字母、数字与厂牌前缀的核对。
    return bool(matching_cids(code, [cid])) and bool(re.fullmatch(r'(?:h_\d+|\d+)?[a-z]+\d+', cid))


def clean(node):
    value = node.get_text(' ', strip=True) if node else ''
    return '' if re.fullmatch(r'[-―－\s]+', value) else value


def headers(session):
    # 年龄确认是公开目录的门页，不是账号登录；保留用户已有会话。
    cookie = str(getattr(session, 'cookie', '') or '')
    parts = [part.strip() for part in cookie.split(';') if part.strip() and part.strip().partition('=')[0] != 'age_check_done']
    return {'Cookie': '; '.join([*parts, 'age_check_done=1'])}


def fetch_dvd(code, session, cid=''):
    if cid:
        if not ordinary_cid(code, cid):
            raise SourceFailure(FailureReason.PARSE_ERROR, 'DMM DVD 商品身份与请求编号不一致，或属于其他版本')
    else:
        url = f'{ORIGIN}/mono/dvd/-/search/=/searchstr={quote(code, safe="")}/'
        page = session.get(url, config=DMM, headers=headers(session))
        soup = BeautifulSoup(page.text, 'html.parser')
        listing = soup.select_one('#list')
        if listing is None and not re.search(r'該当する商品がありません|検索結果がありません|見つかりませんでした|0件', soup.get_text()):
            raise SourceFailure(FailureReason.PARSE_ERROR, '未识别 DMM DVD 搜索结果，无法确认作品是否存在')
        for link in listing.select('p.tmb a[href]') if listing else []:
            candidate = dvd_cid(urljoin(page.url, link['href']))
            if ordinary_cid(code, candidate) and not SPECIAL_EDITION.search(clean(link)):
                cid = candidate
                break
        if not cid:
            raise SourceFailure(FailureReason.NOT_FOUND, 'DMM 配信与 DVD 通贩目录均未取得匹配的普通版作品')
    page = session.get(ORIGIN + DETAIL_PATH.format(cid=cid), config=DMM, headers=headers(session))
    if dvd_cid(page.url) != cid:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'DMM DVD 详情跳转到了其他商品')
    return page


def parse_dvd(page, code):
    cid = dvd_cid(page.url)
    soup = BeautifulSoup(page.text, 'html.parser')
    rows = {}
    for row in soup.select('table tr'):
        cells = row.find_all('td', recursive=False)
        if len(cells) == 2:
            rows[clean(cells[0]).rstrip('：:')] = cells[1]
    native_id = clean(rows.get('品番')).lower()
    canonical = soup.select_one('link[rel="canonical"][href]')
    if not ordinary_cid(code, cid) or native_id != cid or (canonical and dvd_cid(urljoin(page.url, canonical['href'])) != cid):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'DMM DVD 的页面与原生商品身份不一致')
    title = clean(soup.select_one('h1#title'))
    if not title:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'DMM DVD 详情未提供作品标题')
    if SPECIAL_EDITION.search(title):
        raise SourceFailure(FailureReason.NOT_FOUND, 'DMM DVD 返回其他版本，未作为普通版资料采用')

    def links(label):
        cell = rows.get(label)
        return cell.select('a') if cell else []

    def meta(key):
        node = soup.find('meta', property=key)
        return str(node.get('content') or '').strip() if node else ''

    performers = []
    for link in links('出演者'):
        match = re.search(r'/article=actress/id=(\d+)/', link.get('href') or '')
        if clean(link):
            performers.append({'japanese_name': clean(link), 'dmm_id': match[1] if match else ''})
    released = clean(rows.get('発売日')).replace('/', '-')
    try:
        released = date.fromisoformat(released).isoformat()
    except ValueError:
        released = ''
    duration = re.fullmatch(r'(\d+)\s*分', clean(rows.get('収録時間')))
    cover = urljoin(page.url, meta('og:image')) if meta('og:image') else ''
    return SiteRecord(
        source='dmm', provenance='dmm-dvd', code=code, source_url=ORIGIN + DETAIL_PATH.format(cid=cid), title=title,
        performers=tuple(performers), studio=clean(rows.get('メーカー')), label=clean(rows.get('レーベル')),
        series=clean(rows.get('シリーズ')), director=clean(rows.get('監督')), release_date=released,
        runtime=int(duration[1]) if duration else None, tags=tuple(clean(link) for link in links('ジャンル') if clean(link)),
        cover_urls=(cover,) if cover else (), extra={'content_id': cid, 'description': meta('og:description')})
