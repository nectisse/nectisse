"""承接 Peach 来源的最小契约；传输、预算与取消由 Nectisse 会话提供。"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Mapping
from contextlib import contextmanager


class FailureReason(StrEnum):
    NOT_FOUND = "not_found"
    PARSE_ERROR = "parse_error"
    NETWORK = "network"
    TIMEOUT = "timeout"
    RATE_LIMITED = "rate_limited"
    AUTH_REQUIRED = "auth_required"
    ACCESS_DENIED = "access_denied"
    REGION = "region_restricted"
    CHALLENGE = "challenge"
    SERVER_ERROR = "server_error"
    BUDGET = "budget_exceeded"
    UNSUPPORTED = "unsupported"
    CLOUDFLARE_CHALLENGE = "challenge"
    IP_BANNED = "access_denied"
    GEO_RESTRICTED = "region_restricted"
    GONE = "not_found"
    NO_USABLE_METADATA = "parse_error"


class SourceFailure(RuntimeError):
    def __init__(self, reason: FailureReason | str, message: str, *, retry_after: int = 0, status_code=0, detail=""):
        super().__init__(message)
        self.reason = FailureReason(reason)
        self.message = message
        self.retry_after = retry_after
        self.status_code = status_code
        self.detail = detail


class SourceNotFound(SourceFailure):
    pass


def challenge_page(value):
    import re
    value = value.decode('utf-8', 'replace') if isinstance(value, bytes) else str(value)
    return bool(re.search(r'<title[^>]*>\s*(?:Just a moment|请稍候|Attention Required!.*Cloudflare)', value[:8192], re.I))


class Cancelled(Exception):
    pass


@dataclass(frozen=True)
class SiteConfig:
    name: str
    label: str
    provider: str
    base_url: str
    domains: tuple[str, ...]
    stage: str
    interval: float = 2.0
    cookie: bool = False
    page_limit: int = 2 * 1024 * 1024

    @property
    def referer(self) -> str:
        return self.base_url + "/"


@dataclass(frozen=True)
class Page:
    url: str
    body: bytes

    @property
    def text(self) -> str:
        from peach_core.http import body_text
        return body_text(self.body)


@dataclass(frozen=True)
class SiteRecord:
    source: str
    provenance: str
    code: str
    source_url: str
    title: str = ""
    performers: tuple[Mapping[str, Any], ...] = ()
    studio: str = ""
    label: str = ""
    series: str = ""
    director: str = ""
    release_date: str = ""
    runtime: float | None = None
    tags: tuple[str, ...] | None = None
    cover_urls: tuple[str, ...] = ()
    confidence: float = 1.0
    extra: Mapping[str, Any] = field(default_factory=dict)


class SiteSource:
    DEFAULT: SiteConfig

    def __init__(self, config: SiteConfig | None = None):
        self.config = config or type(self).DEFAULT

    def query(self, code: str, *, session: Session) -> SiteRecord:
        return self.parse(self.fetch(code, session=session), code)

    @contextmanager
    def holding(self, session):
        yield


class Session:
    """子类实现 get/post，站点解析器只依赖这两个方法。"""
    def get(self, url: str, *, config: SiteConfig, headers=None) -> Page:
        raise NotImplementedError

    def post(self, url: str, *, config: SiteConfig, body: bytes, headers=None) -> Page:
        raise NotImplementedError
