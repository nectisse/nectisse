"""Sukebei 首页磁链表；按 Peach Fetcher.sukebei 的选择器与编号规则适配。"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from bs4 import BeautifulSoup
from peach_core.catalog_rules import normalise_code_key, _jav_code_pattern
from .metadata.base import Cancelled, FailureReason, SiteConfig, SourceFailure
from .metadata.network import NetworkSession
from . import javtao

ROOT = 'https://sukebei.nyaa.si'
CONFIG = SiteConfig('sukebei', 'Sukebei', 'sukebei-search', ROOT, ('sukebei.nyaa.si',), 'community', page_limit=2 * 1024 * 1024)


def number(text):
    value = str(text).strip().replace(',', '')
    return int(value) if re.fullmatch(r'\d{1,12}', value) else None


def parse_search(body: str, code: str, limit: int = 20) -> list[dict]:
    if type(limit) is not int or limit not in {5, 10, 20}:
        raise ValueError('invalid result limit')
    soup = BeautifulSoup(body, 'html.parser')
    table = soup.select_one('table.torrent-list')
    if table is None:
        info = soup.select_one('.pagination-page-info')
        empty_heading = any(node.get_text(' ', strip=True) == 'No results found' for node in soup.select('h3'))
        if empty_heading and info and re.search(r'\b0-0 out of 0 results\b', info.get_text(' ', strip=True)):
            return []
        raise SourceFailure(FailureReason.PARSE_ERROR, '未找到磁链结果表格，来源页面可能已变化')
    items = []
    seen = set()
    rows = table.select('tbody > tr')
    malformed = 0
    # 日期式编号的分隔符代表发行方，搜索结果不能放宽为另一个分隔符。
    fragment = re.escape(code) if re.fullmatch(r'\d{6}[-_]\d{2,4}', code) else _jav_code_pattern(code) or re.escape(code)
    identity = re.compile(r'(?<![A-Z0-9])(?:' + fragment + r')(?![A-Z0-9])', re.I)
    for row in rows[:100]:
        cells = row.select('td')
        title = row.select_one('td:nth-child(2) a[href^="/view/"]:not(.comments)')
        link = row.select_one('a[href^="magnet:?"]')
        if len(cells) != 8 or title is None or link is None:
            malformed += 1
            continue
        name = title.get_text(' ', strip=True)
        if not identity.search(name):
            continue
        uri = str(link.get('href') or '')
        values = parse_qs(urlsplit(uri).query)
        xt = values.get('xt', [''])[0]
        if not re.fullmatch(r'urn:btih:[a-fA-F0-9]{40}', xt, re.I):
            malformed += 1
            continue
        info_hash = xt.rsplit(':', 1)[1].lower()
        path = str(title.get('href') or '')
        if info_hash in seen or not re.fullmatch(r'/view/\d+', path):
            continue
        # 协议单行有 64 KiB 上限；超长链接保留同一 hash 与有限 tracker。
        if len(uri) > 2400 or len(uri.encode()) > 2400:
            uri = 'magnet:?' + urlencode([('xt', 'urn:btih:' + info_hash)] + [('tr', value) for value in values.get('tr', [])[:4] if len(value) <= 200], safe=':')
        stamp = number(cells[4].get('data-timestamp', ''))
        uploaded = None
        if stamp is not None and stamp < 253402300800:
            uploaded = datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace('+00:00', 'Z')
        item = {
            'id': info_hash, 'title': name[:300], 'magnet': uri,
            'url': urljoin(ROOT, path), 'size': cells[3].get_text(' ', strip=True)[:40],
            'uploadedAt': uploaded, 'seeders': number(cells[5].get_text(strip=True)),
            'leechers': number(cells[6].get_text(strip=True)), 'completed': number(cells[7].get_text(strip=True)),
        }
        if len(json.dumps(items + [item], ensure_ascii=False).encode()) > 58000:
            break
        seen.add(info_hash)
        items.append(item)
        if len(items) == limit:
            break
    if malformed and not items:
        raise SourceFailure(FailureReason.PARSE_ERROR, '磁链结果表格结构不匹配，请稍后重试')
    return items


def job(params, cancelled, permit):
    source = params.get('source', 'sukebei')
    if source not in {'sukebei', 'javtao'}:
        raise ValueError('invalid magnet source')
    code = str(params.get('code') or '').strip().upper()
    if not re.fullmatch(r'[A-Z0-9]+(?:[-_][A-Z0-9]+)*', code) or not 3 <= len(code) <= 64 or normalise_code_key(code).upper() != code:
        raise ValueError('invalid code')
    limit = params.get('maxResults', 20)
    if type(limit) is not int or limit not in {5, 10, 20} or params.get('transport', 'httpx') not in {'httpx', 'fingerprint'}:
        raise ValueError('invalid magnet settings')
    config = javtao.CONFIG if source == 'javtao' else CONFIG
    session = NetworkSession(source, config.domains, cancelled, permit, proxy=str(params.get('proxy') or ''), deadline_seconds=25, fingerprint=source == 'javtao' or params.get('transport') == 'fingerprint')
    try:
        if source == 'javtao':
            page = javtao.fetch_work(session, code)
            items = javtao.parse_magnets(page, code, limit)
        else:
            page = session.get(ROOT + '/?' + urlencode({'f': '0', 'c': '0_0', 'q': code}), config=CONFIG)
            items = parse_search(page.text, code, limit)
        if cancelled.is_set():
            raise Cancelled()
        return {'status': 'ready', 'items': items, 'message': '', 'reason': '', 'requests': session.count, 'retryAfter': 0}
    except SourceFailure as failure:
        return {'status': 'failed', 'items': [], 'message': failure.message, 'reason': failure.reason.value, 'requests': session.count, 'retryAfter': failure.retry_after}
    finally:
        session.close()
