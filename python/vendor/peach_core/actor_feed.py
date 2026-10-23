"""Peach JavDB 演员页纯解析片段，无数据库和网络副作用。"""
from __future__ import annotations
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urljoin
from .catalog_rules import release_code_from_text
MAX_ENTRIES = 200
_TOKEN = re.compile(r"[^\s\[\]()（）【】{}、,，/|_+]+")

#: JavDB 演员页的一部作品：`/v/<id>` 是条目身份，`<strong>` 里是干净的番号，
#: `.meta` 是发行日。固件照抓回来的那份 HTML 写，不按记忆重画。
_JAVDB_BOX = re.compile(
    r'<a href="(?P<href>/v/[A-Za-z0-9]+)" class="box"'
    r'.*?<div class="video-title"><strong>(?P<code>[^<]*)</strong>(?P<title>.*?)</div>'
    r'.*?<div class="meta">\s*(?P<date>\d{4}-\d{2}-\d{2})',
    re.S)
_TAGS = re.compile(r"<[^>]+>")
#: 演员页标题栏：站上这一页挂在哪个名字下，和页面自报的作品数。一位女优常有两页，
#: 本名一页、旧艺名一页（森日向子的另一页挂在「白石アイリ」下），名字是区分两行的唯一线索。
_JAVDB_ACTOR_NAME = re.compile(r'<span class="actor-section-name">([^<]*)</span>')
_JAVDB_WORK_COUNT = re.compile(r'<span class="section-meta">\s*(\d+)\s*部影片\s*</span>')


def stamp(moment: datetime | None = None) -> str:
    """ISO-8601 UTC 文本，与 `task_run`、`entity` 同一种写法。"""
    return (moment or datetime.now(timezone.utc)).astimezone(
        timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def scan_code(text: str | None) -> str | None:
    """从一段文本里找出番号：整段先试一次，不成再逐词元试。

    番号的判据一个字都不新写，全部转给 `catalog_rules.release_code_from_text`——
    两份实现漂移会产生两个封面缓存键，那是 `catalog_rules` 自己注释里记着的旧伤。
    这里加的只是「标题里夹着简介时也要能找到」这一层。
    """
    if not text:
        return None
    whole = release_code_from_text(text)
    if whole:
        return whole
    for token in _TOKEN.findall(str(text)):
        found = release_code_from_text(token)
        if found:
            return found
    return None


@dataclass(frozen=True)
class FeedEntry:
    """一条已解析的条目。`item_key` 是这个源内部的去重真值。"""

    item_key: str
    title: str
    link: str | None = None
    published_at: str | None = None

    @property
    def code(self) -> str | None:
        return scan_code(self.title) or None


@dataclass(frozen=True)
class ParsedFeed:
    title: str | None
    entries: tuple[FeedEntry, ...]


def _published(value: str) -> str | None:
    """`.meta` 里的发行日按 UTC 零点读，认不出就当没有。

    它只有日期、没有时区。按本机时区读的话，同一页在 UTC+8 的机器上整体前移八小时，
    发行日 2026-10-20 变成 10-19，而排序和「这一天发了什么」都按它算。
    发布时间是排序真值：拿不到它才回退到首次见到的时间。把认不出的日期当成「现在」
    会让一整页历史条目全部挤在同一秒，那之后就再也分不出先后了。
    """
    try:
        return stamp(datetime.fromisoformat(value).replace(tzinfo=timezone.utc))
    except ValueError:
        return None


def parse_javdb_actor(html: str, base_url: str) -> ParsedFeed | None:
    """JavDB 演员页 → 条目，`title` 是这一页挂的名字。一条作品都解不出时返回 None。

    解不出不等于这个人没作品：带查询串的地址回过一份 27 KB、一条作品都没有的页面
    （2026-09-22 实测；09-23 同一种 `?t=s` 地址回的是 85 KB、40 条的完整页），不带参数
    的是 78 KB 的完整页。所以这种情况按拉取失败报出来，而不是当成「这次没有新作」——
    后者会把一个坏掉的源伪装成安静的源。

    例外只有页面自己说「0 部影片」的那种：旧艺名页常年挂着空列表（`MmbDR` 白石アイリ，
    2026-09-28 实测），那是一个真实存在、只是没有作品的源，返回零条。判据是页面自报的
    计数，不是「暂无内容」那行字——计数不为零却没有作品，照旧算失败。
    """
    if not html:
        return None
    named = _JAVDB_ACTOR_NAME.search(html)
    name = (named.group(1).strip() or None) if named else None
    rows: list[FeedEntry] = []
    for found in list(_JAVDB_BOX.finditer(html))[:MAX_ENTRIES]:
        href = found.group("href")
        code = found.group("code").strip()
        tail = _TAGS.sub("", found.group("title")).strip()
        title = f"{code} {tail}".strip() if code else tail
        rows.append(FeedEntry(href, title, urljoin(base_url, href),
                              _published(found.group("date"))))
    if not rows:
        counted = _JAVDB_WORK_COUNT.search(html)
        if name and counted and int(counted.group(1)) == 0:
            return ParsedFeed(name, ())
        return None
    return ParsedFeed(name, tuple(rows))


