"""复用 Peach 的资料来源；返回可追溯字段，不建立人物或创作者身份猜测。"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from peach_core.catalog_rules import normalise_code_key, same_release_code
from peach_core.cover_identity import is_cross_product_cover
from peach_core.identity import identifies_code
from peach_core.sources.dmm import SEARCH_QUERY
from .dmm import VerifiedDmmSource
from ..javtao import JavTaoSource
from peach_core.sources.r18dev import R18DevSource
from peach_core.sources.fc2 import Fc2Source, video_id
from peach_core.sources.onepondo import OnePondoSource
from peach_core.sources.fc2ppvdb import Fc2ppvdbSource
from peach_core.sources.javten import JavtenSource
from peach_core.sources.javarchive import JavArchiveSource
from peach_core.sources.avbase import AVBaseSource
from peach_core.sources.javbus import JavBusSource
from peach_core.sources.javdb import JavDBSource
from peach_core.sources.seesaa import WIKI_SOURCES
from nectisse_worker.catalog import CATALOG, image_domains
from .amane import AmaneSource, CLASSES
from .base import FailureReason, Page, SourceFailure
from .network import allowed_url
from .cover_candidates import cover_urls

SOURCES = {"r18dev": R18DevSource, "dmm": VerifiedDmmSource, "fc2": Fc2Source, '1pondo': OnePondoSource, 'fc2ppvdb': Fc2ppvdbSource, 'javten': JavtenSource, 'javarchive': JavArchiveSource, 'avbase': AVBaseSource, 'javbus': JavBusSource, 'javdb': JavDBSource, 'javtao': JavTaoSource, **WIKI_SOURCES, **{key: (lambda key=key: AmaneSource(key)) for key in CLASSES}}
SAFE_CODE = re.compile(r"^(?:FC2-PPV-\d{5,}|(?:\d{1,3})?[A-Z]{2,8}-\d{2,5}|\d{6}[-_]\d{2,4})$")


def from_cid(cid: str) -> str:
    match = re.fullmatch(r"(?:h_\d+)?(?:(\d{1,3}))?([a-z]{2,8})(\d{2,5})", cid, re.I)
    if not match:
        return ""
    prefix, stem, digits = match.groups()
    return normalise_code_key(f"{prefix or ''}{stem}-{digits}")


def text(value, maximum=500) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:maximum]


def normalize(record) -> dict:
    canonical_code = normalise_code_key(record.code)
    extra = record.extra
    raw = extra.get("raw") or {}
    warnings = [text(value, 500) for value in extra.get('source_warnings', [])][:10]
    if len(record.performers) > 40 or len(record.tags or ()) > 60:
        warnings.append("来源条目较多，当前仅保留前 40 位出演人物与前 60 个标签")
    title = text(record.title, 1000)
    language = 'ja' if record.source in {'dmm', 'r18dev'} else 'unknown'
    if not title and record.source == "r18dev":
        title = text(raw.get("title"), 1000)
        language = "en"
        warnings.append("日文标题未取得；保留来源实际提供的英文标题")
    summary = text(extra.get("description"), 4000)
    if len(str(extra.get("description") or "")) > 4000:
        warnings.append("简介超过显示预算，已截取前 4000 个字符")
    content_id = text(extra.get("content_id"), 100)
    people = [{"name": text(person.get("japanese_name"), 100), "role": "performer", "sourceIdentity": text(person.get("external_id") or person.get("dmm_id"), 1000 if record.source == 'javtao' else 100)} for person in record.performers if person.get("japanese_name")][:40]
    if record.director:
        people.append({"name": text(record.director, 100), "role": "director", "sourceIdentity": ""})
    seller_source = record.source in {'fc2', 'fc2ppvdb', 'javten', 'javarchive'} and record.code.startswith('FC2')
    seller = text(record.label, 200) if seller_source else ""
    if seller:
        people.append({"name": seller, "role": "seller", "sourceIdentity": text(extra.get("seller_url"), 1000)})
    candidates = []
    for url in cover_urls(record.code, record.cover_urls, image_domains(record.source)):
        if not isinstance(url, str) or len(url) > 2000 or is_cross_product_cover(record.code, url):
            warnings.append("已排除身份不一致的封面 URL")
            continue
        domains = image_domains(record.source)
        if not allowed_url(url, domains):
            warnings.append("已排除不在当前允许图床范围的封面")
            continue
        if record.source != 'javdb':
            candidates.append({"id": hashlib.sha256(url.encode()).hexdigest(), "url": url, "source": record.source, "identity": "source-matched"})
    # 厂牌、平台、卖家与人物分别保留；FC2 不把平台名填成创作者或厂牌。
    result = {
        "id": hashlib.sha256(f"{record.source}:{content_id or record.code}".encode()).hexdigest(),
        "source": record.source, "parser": record.provenance, "parserVersion": "nectisse-javtao-1" if record.source == 'javtao' else "peach-0.46.1/nectisse-1",
        "code": canonical_code, "contentId": content_id, "sourceUrl": record.source_url,
        "fetchedAt": datetime.now(timezone.utc).isoformat(), "title": title, "titleLanguage": language,
        "people": people, "studio": "" if seller_source else text(record.studio),
        "label": "" if seller_source else text(record.label), "seller": seller,
        "sellerUrl": text(extra.get("seller_url"), 1000), "series": text(record.series),
        "releaseDate": text(record.release_date, 32), "deliveryDate": text(extra.get('delivery_date'), 32), "description": summary,
        "tags": [text(tag, 100) for tag in record.tags or ()][:60], "covers": candidates[:3], "warnings": warnings,
    }
    # 单条协议消息有上限；保留状态说明，不能悄悄把超限当成完整结果。
    while len(json.dumps(result, ensure_ascii=False).encode()) > 48 * 1024:
        result["warnings"] = ["资料超过传输预算，部分简介、标签或人物被截取"]
        result["description"] = result["description"][:len(result["description"]) // 2]
        result["tags"] = result["tags"][:len(result["tags"]) // 2]
        result["people"] = result["people"][:len(result["people"]) // 2]
    return result


def query(params: dict, session, on_record=lambda record: None) -> list[dict]:
    source = params.get("source")
    if source not in SOURCES:
        raise SourceFailure(FailureReason.UNSUPPORTED, "当前未接入此资料来源")
    adapter = SOURCES[source]()
    kind = params.get("kind")
    if kind == 'url':
        return query_url(params, adapter, session, on_record)
    if kind == "title":
        if source != "dmm":
            raise SourceFailure(FailureReason.UNSUPPORTED, "标题查询当前仅接入 DMM")
        title = str(params.get("query") or "").strip()
        if not 2 <= len(title) <= 200:
            raise SourceFailure(FailureReason.UNSUPPORTED, "标题需要 2 到 200 个字符")
        data = adapter.graphql(SEARCH_QUERY, {"limit": 6, "sort": "RELEASE_DATE", "queryWord": title}, session=session)
        node = data.get("legacySearchPPV") or {}
        rows = (node.get("result") or {}).get("contents") or []
        results = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or len(results) >= 3:
                continue
            cid = str(row.get("id") or "")
            if not re.fullmatch(r"[a-zA-Z0-9_]{2,100}", cid) or cid in seen:
                continue
            seen.add(cid)
            item = adapter.content(cid, session=session)
            if item is None:
                continue
            code = normalise_code_key(str(item.get("makerContentId") or ""))
            if not SAFE_CODE.fullmatch(code):
                code = from_cid(cid)
            if not code or not identifies_code(code, {"id": item.get("makerContentId"), "content_id": cid}):
                continue
            record = adapter.parse(Page(adapter.content_url(cid), json.dumps(item).encode()), code)
            normalized = normalize(record)
            results.append(normalized)
            on_record(normalized)
        return results
    code = str(params.get("code") or "")
    family = 'fc2' if code.startswith('FC2') else 'dated' if re.fullmatch(r'\d{6}[-_]\d{2,4}', code) else 'standard'
    if not SAFE_CODE.fullmatch(code) or family not in CATALOG[source]['families']:
        raise SourceFailure(FailureReason.UNSUPPORTED, "该来源不支持此编号类型；分段 FC2 编号不会合并成整部作品")
    cid = str(params.get("contentId") or "")
    if cid and not re.fullmatch(r"[a-zA-Z0-9_]{2,100}", cid):
        raise SourceFailure(FailureReason.UNSUPPORTED, "来源商品身份不正确")
    if source == "dmm" and cid:
        item = adapter.identified(code, cid, session=session)
        if item is None:
            raise SourceFailure(FailureReason.NOT_FOUND, "未取得与请求身份一致的 DMM 商品")
        record = adapter.parse(Page(adapter.content_url(cid), json.dumps(item).encode()), code)
    else:
        record = adapter.query(code, session=session)
    if not same_release_code(code, record.code):
        raise SourceFailure(FailureReason.PARSE_ERROR, '来源返回的作品身份与请求不一致')
    normalized = normalize(record)
    on_record(normalized)
    return [normalized]


def query_url(params, adapter, session, on_record):
    source, url = params['source'], str(params.get('sourceUrl') or '')
    if not allowed_url(url, tuple(CATALOG[source]['domains'])):
        raise SourceFailure(FailureReason.UNSUPPORTED, '原站链接不属于所选资料来源')
    page = session.get(url, config=adapter.config)
    if source == 'javdb':
        from peach_core.sources.javdb import _PANEL
        from peach_core.javdb import clean
        shown = clean(dict((clean(label), value) for label, value in _PANEL.findall(page.text)).get('番號', '')).replace(' ', '')
        if not SAFE_CODE.fullmatch(shown):
            raise SourceFailure(FailureReason.PARSE_ERROR, '作品链接未返回可核对的编号')
        record = adapter.parse(page, shown)
    elif source == 'javtao':
        record = adapter.parse(page, '')
        if not SAFE_CODE.fullmatch(record.code):
            raise SourceFailure(FailureReason.UNSUPPORTED, 'JavTao 作品编号类型尚未支持')
    else:
        raise SourceFailure(FailureReason.UNSUPPORTED, '此来源请使用作品编号查询')
    result = normalize(record)
    on_record(result)
    return [result]
