"""FANBOX 动态与 JavDB 演员目录。查找只返回候选，关注由 TS 持久化。"""
from __future__ import annotations
import hashlib
import io
import json
import re
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode, urljoin
from bs4 import BeautifulSoup
from PIL import Image
from peach_core import javdb
from peach_core.actor_feed import parse_javdb_actor
from peach_core.fanbox import normalize_fanbox_post, FanboxContentError
from .metadata.base import FailureReason, SourceFailure, SiteConfig
from .metadata.network import NetworkSession, allowed_url
from .catalog import CATALOG, image_domains
from . import follow_extended

CONFIGS = {
    "fanbox": SiteConfig("fanbox", "FANBOX", "fanbox-public", "https://www.fanbox.cc", ("fanbox.cc", "pximg.net"), "official"),
    "javdb": SiteConfig("javdb", "JavDB", "javdb-actor", "https://javdb.com", ("javdb.com", "jdbstatic.com", "jdbimgs.com"), "directory"),
}
CONFIGS.update({key: SiteConfig(key, row['name'], 'peach-posts', row['root'].rstrip('/'), tuple(dict.fromkeys(row['domains'] + row['images'])), 'creator') for key, row in CATALOG.items() if row['follow'] and key not in CONFIGS})
HANDLE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ACTOR = re.compile(r"^[A-Za-z0-9]{1,16}$")
LOGIN = re.compile(r"<title[^>]*>\s*(?:登入|登录|Login|Sign in|Age Verification)|age.verification", re.I)


def clean(value, limit=1000):
    return BeautifulSoup(str(value or ""), "html.parser").get_text(" ", strip=True)[:limit]


def javdb_avatar(html, ref, *, profile=False):
    """只取当前演员卡／主页的头像，不从作品封面或其他演员卡推断。"""
    soup = BeautifulSoup(html, 'html.parser')
    scope = soup.select_one('.actor-avatar') if profile else soup.select_one(f'.actor-box a[href="/actors/{ref}"]')
    if not scope:
        return ''
    image = scope.select_one('img.avatar, .avatar img, figure img, img')
    raw = str(image.get('data-src') or image.get('src') or '') if image else ''
    if not raw:
        avatar = scope.select_one('.avatar[style]')
        match = re.search(r'''background-image\s*:\s*url\(\s*['"]?([^'"\s)]+)''', str(avatar.get('style') or ''), re.I) if avatar else None
        raw = match.group(1) if match else ''
    url = urljoin('https://javdb.com/', raw) if raw else ''
    return url if allowed_url(url, image_domains('javdb')) else ''


def identity(provider, value):
    value = str(value or "").strip()
    if "://" in value:
        parsed = urlsplit(value)
        if not allowed_url(value, ("fanbox.cc",) if provider == "fanbox" else ("javdb.com",)):
            raise SourceFailure(FailureReason.UNSUPPORTED, "请使用当前来源的 HTTPS 主页链接")
        if provider == "fanbox":
            if parsed.hostname in {"www.fanbox.cc", "fanbox.cc"}:
                match = re.fullmatch(r"/@([^/]+)/?", parsed.path)
                value = match.group(1) if match else ""
            else:
                value = parsed.hostname.removesuffix(".fanbox.cc") if parsed.path in {"", "/"} else ""
        else:
            match = re.fullmatch(r"/actors/([A-Za-z0-9]+)/?", parsed.path)
            value = match.group(1) if match else ""
    pattern = HANDLE if provider == "fanbox" else ACTOR
    if not pattern.fullmatch(value) or value in {"www", "api"}:
        raise SourceFailure(FailureReason.UNSUPPORTED, "请输入 FANBOX 主页或账号 id" if provider == "fanbox" else "演员主页身份不正确")
    return value.lower() if provider == "fanbox" else value


def headers(provider, cookie):
    result = {"Accept": "application/json" if provider == "fanbox" else "text/html"}
    if provider == "fanbox":
        result.update({"Origin": "https://www.fanbox.cc", "Referer": "https://www.fanbox.cc/"})
    if cookie:
        if "\n" in cookie or "\r" in cookie or len(cookie) > 12000:
            raise SourceFailure(FailureReason.UNSUPPORTED, "Cookie 格式或长度不正确")
        result["Cookie"] = cookie
    return result


def get(session, url, params, *, detail=False):
    provider = params["provider"]
    response = session.request("GET", url, config=CONFIGS[provider], headers=headers(provider, str(params.get("cookie") or "")), fingerprint=detail or params.get("transport") == "fingerprint")
    if provider == "javdb":
        text = response.body.decode("utf-8", "replace")
        if 'country where your internet is located' in text or '禁止了你的網路所在國家' in text:
            raise SourceFailure(FailureReason.REGION, "JavDB 限制当前出口所在地区，请在网络设置调整出口后重试")
        if javdb.LOGIN.search(text) or LOGIN.search(text[:50000]):
            raise SourceFailure(FailureReason.AUTH_REQUIRED, "JavDB 返回登录或年龄确认页，请在来源设置配置有效 Cookie")
        return text
    payload = json.loads(response.body)
    if not isinstance(payload, dict) or payload.get("error") or not isinstance(payload.get("body"), dict):
        raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 没有返回可用资料，账号可能不存在或当前不可访问")
    return payload["body"]


def lookup(params, session):
    provider, value = params["provider"], str(params.get("query") or "").strip()
    if provider not in {'fanbox', 'javdb'}:
        return follow_extended.lookup(params, session, CONFIGS[provider])
    if provider == "fanbox":
        ref = identity(provider, value)
        profile = get(session, "https://api.fanbox.cc/creator.get?" + urlencode({"creatorId": ref}), params)
        user = profile.get("user") or {}
        if not str(user.get("userId") or "").isdigit() or not user.get("name"):
            raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 没有返回可核实的创作者身份")
        avatar = str(user.get('iconUrl') or '')
        return [{"provider": provider, "ref": ref, "name": clean(user["name"], 200), "url": f"https://{ref}.fanbox.cc/", "aliases": [], "recordType": "创作者主页", "bio": clean(profile.get("description"), 1000), "evidence": "FANBOX creator.get 返回的账号与用户身份", "avatarUrl": avatar if allowed_url(avatar, image_domains(provider)) else ''}]
    if "://" in value:
        ref = identity(provider, value)
        html = get(session, f"https://javdb.com/actors/{ref}", params)
        names = javdb.current_names(html)
        native = javdb.actor_id(html)
        if not names or (native and native != ref):
            raise SourceFailure(FailureReason.PARSE_ERROR, "演员页没有返回与请求一致的身份")
        cards = [{"id": ref, "names": names, "record": ""}]
    else:
        if not 1 <= len(value) <= 100:
            raise SourceFailure(FailureReason.UNSUPPORTED, "演员名需要 1 至 100 个字符")
        from urllib.parse import quote
        html = get(session, javdb.SEARCH.format(quote(value)), params)
        cards = javdb.search_cards(html)[:8]
        if not cards and not any(marker in html for marker in ("沒有結果", "没有结果", "No results", "沒有找到", "找不到")):
            raise SourceFailure(FailureReason.PARSE_ERROR, "JavDB 搜索页未识别出演员卡，不能确认是否没有结果")
    return [{"provider": provider, "ref": card["id"], "name": clean(card["names"][0], 200), "url": f"https://javdb.com/actors/{card['id']}", "aliases": [clean(name, 200) for name in card["names"][:12]], "recordType": clean(card.get("record"), 100) or "演员记录", "bio": "", "evidence": "JavDB 演员页原生 id；请核对姓名与记录类型", "avatarUrl": javdb_avatar(html, card['id'], profile='://' in value)} for card in cards if card.get("names")]


def check(params, session, publish):
    provider = params["provider"]
    if provider not in {'fanbox', 'javdb'}:
        return follow_extended.check(params, session, publish, CONFIGS[provider])
    ref = identity(provider, params.get("ref"))
    seen = set(str(key) for key in params.get("seen", [])[:200])
    first = not params.get("initialized")
    overlap, ended, count, pages = False, False, 0, 0
    warnings = []
    avatar_url = ''
    for page in range(1 if first else 2):
        pages += 1
        if provider == "fanbox":
            if page == 0:
                url = "https://api.fanbox.cc/post.listCreator?" + urlencode({"creatorId": ref, "limit": 10})
            else:
                listing = get(session, "https://api.fanbox.cc/post.paginateCreator?" + urlencode({"creatorId": ref}), params)
                urls = listing.get("pageUrls")
                if not isinstance(urls, list):
                    raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 分页清单格式不符")
                if len(urls) < 2:
                    ended = True; break
                url = str(urls[1])
                parsed = urlsplit(url)
                if parsed.hostname != "api.fanbox.cc" or parsed.path != "/post.listCreator" or parse_qs(parsed.query).get("creatorId") != [ref]:
                    raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 分页游标不属于当前创作者")
            data = get(session, url, params)
            rows = data.get("posts")
            if not isinstance(rows, list):
                raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 帖子列表格式不符")
            ended = len(rows) < 10
            if page == 0 and rows:
                icon = str((rows[0].get('user') or {}).get('iconUrl') or '') if isinstance(rows[0], dict) else ''
                avatar_url = icon if allowed_url(icon, image_domains(provider)) else ''
            for post in rows[:10]:
                if not isinstance(post, dict) or not str(post.get("id") or "").isdigit():
                    raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 帖子缺少原生身份")
                key = str(post["id"])
                overlap |= key in seen
                restricted = bool(post.get("isRestricted") or int(post.get("feeRequired") or 0) > 0)
                cover = post.get("cover") or {}
                summary = clean(post.get("excerpt"), 3000)
                thumb = str(cover.get("url") or "") if isinstance(cover, dict) else ""
                partial = True
                # 只为最多两条新增公开帖补正文，文字公告同样保留，不按附件或链接筛选。
                if not restricted and key not in seen and count < 2:
                    try:
                        detail = get(session, "https://api.fanbox.cc/post.info?" + urlencode({"postId": key}), params, detail=True)
                        detail = detail.get("post") if isinstance(detail.get("post"), dict) else detail
                        if str(detail.get("id")) != key:
                            raise SourceFailure(FailureReason.PARSE_ERROR, "FANBOX 详情身份不一致")
                        if not detail.get("isRestricted") and not int(detail.get("feeRequired") or 0):
                            content = normalize_fanbox_post(detail)
                            summary = clean(content.summary, 3000) or summary
                            partial = False
                    except (SourceFailure, FanboxContentError, ValueError, TypeError):
                        warnings.append("部分正文未取得，已保留来源列表提供的摘要")
                publish({"externalId": key, "title": clean(post.get("title"), 1000), "summary": summary, "author": clean((post.get("user") or {}).get("name"), 200) or params.get("name", ""), "publishedAt": str(post.get("publishedDatetime") or "")[:100], "url": f"https://{ref}.fanbox.cc/posts/{key}", "thumbnailUrl": thumb if allowed_url(thumb, ("pximg.net", "fanbox.cc")) else "", "code": "", "restricted": restricted, "partial": partial})
                count += 1
        else:
            url = f"https://javdb.com/actors/{ref}" + ("?page=2" if page else "")
            html = get(session, url, params)
            native = javdb.actor_id(html)
            if native and native != ref:
                raise SourceFailure(FailureReason.PARSE_ERROR, "JavDB 返回了另一位演员的页面")
            parsed = parse_javdb_actor(html, url)
            if parsed is None:
                raise SourceFailure(FailureReason.PARSE_ERROR, "演员页没有可解析目录，不能视为没有新作")
            soup = BeautifulSoup(html, "html.parser")
            if page == 0:
                avatar_url = javdb_avatar(html, ref, profile=True)
            ended = not soup.select_one('a[rel="next"], a.pagination-next[href]')
            for item in parsed.entries[:40]:
                overlap |= item.item_key in seen
                image = soup.select_one(f'a[href="{item.item_key}"] img')
                thumb = str(image.get("data-src") or image.get("src") or "") if image else ""
                publish({"externalId": item.item_key, "title": clean(item.title, 1000), "summary": "目录新增收录；发行日期与发现时间分别保存。", "author": params.get("name", ""), "publishedAt": item.published_at or "", "url": item.link or "", "thumbnailUrl": thumb if allowed_url(thumb, ("jdbstatic.com", "jdbimgs.com", "javdb.com")) else "", "code": item.code or "", "restricted": False, "partial": False})
                count += 1
        if overlap or ended:
            break
    complete = overlap or ended
    return {"coverage": "初次收录：仅检查首页，历史未抓取" if first else "已覆盖到上次记录" if overlap else "已到来源列表末尾" if ended else "已检查最多两页，尚未覆盖到上次记录", "gap": not first and not complete, "pages": pages, "warnings": list(dict.fromkeys(warnings)), "avatarUrl": avatar_url}


def job(method, params, cancelled, permit, publish):
    provider = params.get("provider")
    if provider not in CONFIGS:
        raise SourceFailure(FailureReason.UNSUPPORTED, "未接入此订阅来源")
    session = NetworkSession(provider, CONFIGS[provider].domains, cancelled, permit, proxy=str(params.get("proxy") or ""))
    try:
        if method == "follow.image":
            url = str(params.get("url") or "")
            if not allowed_url(url, image_domains(provider)):
                raise SourceFailure(FailureReason.ACCESS_DENIED, "封面地址不属于当前来源图床")
            response = session.request('GET', url, config=CONFIGS[provider], limit=8 * 1024 * 1024, fingerprint=params.get('transport') == 'fingerprint')
            import warnings
            Image.MAX_IMAGE_PIXELS = 40_000_000
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(response.body)) as image:
                    width, height = image.size
                    format = image.format
                    if format not in {'JPEG', 'PNG', 'WEBP'} or width < 80 or height < 80 or getattr(image, 'n_frames', 1) != 1:
                        raise SourceFailure(FailureReason.PARSE_ERROR, '来源封面格式或尺寸不可用')
                    image.verify()
                with Image.open(io.BytesIO(response.body)) as image:
                    image.load()
            if cancelled.is_set():
                from .metadata.base import Cancelled
                raise Cancelled()
            Path(params['destination']).write_bytes(response.body)
            result = {'asset': {'sha256': hashlib.sha256(response.body).hexdigest(), 'width': width, 'height': height, 'bytes': len(response.body), 'format': format, 'quality': 'standard' if width >= 700 else 'small'}}
        elif method == "follow.lookup":
            result = {"candidates": lookup(params, session)}
        else:
            result = check(params, session, publish)
        return {"status": "partial" if session.failures else "success", "reason": session.failures[-1].reason if session.failures else "", "message": "来源查询完成", "requests": session.count, "retryAfter": max((failure.retry_after for failure in session.failures), default=0), **result}
    except SourceFailure as error:
        return {"status": "error", "reason": error.reason, "message": error.message, "retryAfter": error.retry_after, "requests": session.count}
    except (ValueError, TypeError, AttributeError, KeyError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return {"status": "error", "reason": "parse_error", "message": "来源数据结构与解析器不匹配", "retryAfter": 0, "requests": session.count}
    finally:
        session.close()
