"""Peach Patreon 公开卡片解析。网络由 Nectisse 注入。"""
from __future__ import annotations
import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Mapping
from bs4 import BeautifulSoup
from nectisse_worker.follow_official_support import _BaseConnector, ParsedSource, FollowSourceError, plain_text

@dataclass(frozen=True)
class FollowCandidate:
    """一个未经复核的追更候选。"""

    provider: str
    external_id: str
    title: str
    url: str | None = None
    media_url: str | None = None
    thumb_url: str | None = None
    published_at: str | None = None
    version: str | None = None
    duration: float | None = None
    author: str | None = None
    summary: str | None = None
    #: 来源自带的分组标识。可能是站内的父帖，也可能是归一化后的跨站出处键
    #: （`fanbox:12304831` 这种）。有它就不必靠标题猜同一作品的变体。
    group_hint: str | None = None
    #: 标题是不是一个真正的名字。booru 没有标题，只能拿标签凑一个可读标签——
    #: 那种「标题」不能参与按标题分组，否则同一作者的两个作品会因标签相似被并掉。
    title_is_name: bool = True
    extra: Mapping[str, object] = field(default_factory=dict)
    #: 这一条只有列表阶段的视图，详情没有取（额度用完、库里已经补齐过，或者详情页
    #: 这次被挡回来）。落库时它**不得覆盖**已有的细节：详情给出的上传时间、时长、
    #: 媒体地址和 metadata 要原样留着，只更新列表本来就权威的那几列。
    partial: bool = False


@dataclass(frozen=True)
class SourceFetch:
    provider: str
    ref: str
    request_url: str
    semantics: str
    candidates: tuple[FollowCandidate, ...] = ()
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False
    #: 这次抓取里被判为「不是 release」而丢掉的条数。必须报出来：用户看到的条目数
    #: 比站点上少的时候，他得能分清少的是被过滤掉的，还是根本没抓到。
    skipped: int = 0
    #: `skipped` 里有多少条是来源详情确认的跨作者合集。单列出来让界面能说清
    #: 「主动不收」而不是把它误报成「没有资源」。
    skipped_compilations: int = 0
    #: 列表判不出来、额外抓了详情页的条数。这是唯一会放大请求数的路径，
    #: 报出来才能看出某个作者是不是每一帖都要多打一次站点。
    probed: int = 0
    raw_body: bytes | None = field(default=None, repr=False, compare=False)


def _iso_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


_RELATIVE_RE = re.compile(
    r"(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*(?:ago)?", re.IGNORECASE)

#: 相对时间换算成秒。月按 30 天、年按 365 天——只用来排序，不当精确发布时间用。
_RELATIVE_SECONDS = {
    "second": 1, "minute": 60, "hour": 3600, "day": 86400,
    "week": 604800, "month": 2592000, "year": 31536000,
}


def _iso_from_relative(text: str | None, *, now: datetime | None = None) -> str | None:
    """把 `1 week ago` 这类相对时间换算成近似 UTC 时间戳。

    部分公开卡片只给相对时间，没有绝对时间。换算结果**是近似值**，
    调用方必须在 `extra` 里标出 `published_precision='approximate'`，
    界面上也要照实显示，不能当成站点给出的精确发布时间。
    """
    if not text:
        return None
    matched = _RELATIVE_RE.search(text)
    if not matched:
        return None
    amount = int(matched.group(1))
    unit = _RELATIVE_SECONDS[matched.group(2).lower()]
    reference = now or datetime.now(timezone.utc)
    return _iso_utc(reference - timedelta(seconds=amount * unit))


_SLUG_TAIL_RE = re.compile(r"^(?:19|20)\d{2}$|^v?\d+(?:\.\d+)+[a-z]?$")


def _slug_label(slug: str) -> str:
    words = [word for word in re.split(r"[-_]+", slug) if word]
    kept: list[str] = []
    for word in words:
        if kept and _SLUG_TAIL_RE.match(word):
            break
        kept.append(word)
    return " ".join(kept).strip() or re.sub(r"[-_]+", " ", slug).strip() or slug


def _visible_post_image(node) -> str | None:
    image = node.select_one("img[src]") if node is not None else None
    return str(image.get("src")) if image is not None and image.get("src") else None


class PatreonConnector(_BaseConnector):
    """Patreon 公开创作者页。

    Patreon 的正式 posts API 要创作者 OAuth scope，不能用于任意作者；这里仅读取官网
    已经服务端渲染给公开访客的帖子卡片，不碰登录态或私有 API。
    """

    provider = "patreon"
    _VANITY_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
    _POST_RE = re.compile(r"/posts/(?:[^/?#]*-)?(\d{4,})(?:[/?#]|$)")

    #: 这些首段路径是站点自己的功能页，不是创作者短名。
    _RESERVED = frozenset({"posts", "join", "login", "signup", "home", "explore"})

    @classmethod
    def parse_url(cls, provider: str, parsed: urllib.parse.SplitResult,
                  host: str) -> "ParsedSource":
        path = parsed.path or "/"
        user_id = urllib.parse.parse_qs(parsed.query).get("u", [""])[0]
        if path.rstrip("/") == "/user" and user_id.isdigit():
            return ParsedSource("patreon", f"user/{user_id}",
                                f"https://www.patreon.com/user?u={user_id}",
                                f"Patreon {user_id}")
        parts = [part for part in path.split("/") if part]
        if parts and parts[0] == "cw":
            parts = parts[1:]
        if not parts or parts[0].lower() in cls._RESERVED:
            raise FollowSourceError(
                "Patreon 的链接要指向创作者主页，形如 https://patreon.com/cw/creator")
        vanity = parts[0]
        return ParsedSource("patreon", vanity,
                            f"https://www.patreon.com/cw/{vanity}", vanity)

    @classmethod
    def profile_handle(cls, ref: str) -> str:
        value = str(ref or "").strip().strip("/")
        if value.startswith("user/") or value.isdigit():
            # 数字用户 id 页没有短名，`user/12345` 不是作者的名字。
            return ""
        return value.rsplit("/", 1)[-1]

    def _url(self, ref: str) -> str:
        value = str(ref or "").strip()
        if value.startswith("user/") and value[5:].isdigit():
            return f"https://www.patreon.com/user?u={value[5:]}"
        if not self._VANITY_RE.fullmatch(value):
            raise FollowSourceError(f"patreon 的 ref 必须是创作者短名，收到：{ref!r}")
        return f"https://www.patreon.com/cw/{value}"

    def fetch(self, ref: str, *, etag: str | None = None,
              last_modified: str | None = None, page: int = 0) -> SourceFetch:
        if page:
            raise FollowSourceError("Patreon 官方来源暂不支持向前翻页")
        url = self._url(ref)
        common, response = self._request(url, ref=ref, etag=etag,
                                         last_modified=last_modified,
                                         headers={"Accept": "text/html"})
        if response is None:
            return SourceFetch(not_modified=True, **common)
        try:
            soup = BeautifulSoup(response.body.decode("utf-8"), "html.parser")
        except UnicodeDecodeError as exc:
            raise FollowSourceError("patreon 返回的页面不是 UTF-8") from exc
        candidates, seen = [], set()
        for anchor in soup.select("a[href*='/posts/']"):
            href = str(anchor.get("href") or "")
            matched = self._POST_RE.search(urllib.parse.urlsplit(href).path)
            if not matched or matched.group(1) in seen:
                continue
            post_id = matched.group(1)
            seen.add(post_id)
            node = anchor
            for _ in range(8):
                if node is None or node.select_one("h3") is not None:
                    break
                node = node.parent
            title_node = node.select_one("h3") if node is not None else None
            title = plain_text(title_node.get_text(" ") if title_node else "")
            if not title:
                slug = urllib.parse.urlsplit(href).path.rsplit("/", 1)[-1]
                title = _slug_label(re.sub(rf"-{post_id}$", "", slug))
            text = plain_text(node.get_text(" ") if node is not None else "") or ""
            relative = _RELATIVE_RE.search(text)
            candidates.append(FollowCandidate(
                provider=self.provider,
                external_id=post_id,
                title=title or f"Patreon 帖子 {post_id}",
                url=urllib.parse.urljoin("https://www.patreon.com", href),
                thumb_url=_visible_post_image(node),
                published_at=_iso_from_relative(relative.group(0)) if relative else None,
                group_hint=f"patreon:{post_id}",
                extra={"official": True, "public_page": True,
                       "published_precision": "approximate"},
            ))
            if len(candidates) >= self.max_items:
                break
        return SourceFetch(candidates=tuple(candidates), raw_body=response.body, **common)


