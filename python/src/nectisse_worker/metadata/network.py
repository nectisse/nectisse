"""有界 HTTPS 会话；每条请求由 TS 授权，重定向也重新核验和计数。"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import replace
from urllib.parse import urlsplit

import httpx
from peach_core.http import HttpRequest, HttpxTransport, public_https_url, resolves_publicly
from peach_core.user_agent import USER_AGENT
from .base import Cancelled, FailureReason, Page, Session, SiteConfig, SourceFailure

CHALLENGE = re.compile(r"<title[^>]*>\s*(?:Just a moment|请稍候|Attention Required!.*Cloudflare)", re.I)
LOGIN_PATH = re.compile(r"/(?:login|signin|sign_in|age_?check)(?:[/?.]|$)", re.I)


def allowed_url(url: str, domains: tuple[str, ...]) -> bool:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        return public_https_url(url) and parsed.port in (None, 443) and any(host == domain or host.endswith('.' + domain) for domain in domains)
    except ValueError:
        return False


class NetworkSession(Session):
    def __init__(self, source: str, domains: tuple[str, ...], cancelled: threading.Event, permit, *, client=None, verify_dns=True, deadline_seconds=45, proxy="", cookie="", fingerprint=False):
        self.source = source
        self.proxy = proxy
        if '\n' in cookie or '\r' in cookie or len(cookie) > 12000:
            raise SourceFailure(FailureReason.UNSUPPORTED, 'Cookie 格式不正确')
        self.cookie = cookie
        self.fingerprint = fingerprint
        self.fingerprinted = None
        self.domains = domains
        self.cancelled = cancelled
        self.permit = permit
        self.deadline = time.monotonic() + deadline_seconds
        self.count = 0
        self.failures: list[SourceFailure] = []
        self.verify_dns = verify_dns and not proxy
        if proxy:
            parsed = urlsplit(proxy)
            if parsed.scheme not in {"http", "https", "socks5", "socks5h"} or not parsed.hostname or parsed.username or parsed.password:
                raise SourceFailure(FailureReason.NETWORK, "系统代理格式或认证方式暂不支持")
        self.client = client or httpx.Client(trust_env=False, proxy=proxy or None, headers={"User-Agent": USER_AGENT}, event_hooks={"request": [self.guard]})
        if client is not None:
            self.client.event_hooks["request"] = [self.guard]
        self.transport = HttpxTransport(self.client)

    def guard(self, request: httpx.Request) -> None:
        if self.cancelled.is_set():
            raise Cancelled()
        if time.monotonic() >= self.deadline or self.count >= 8:
            raise SourceFailure(FailureReason.BUDGET, "本次来源查询已达到请求或时间预算")
        url = str(request.url)
        if not allowed_url(url, self.domains):
            raise SourceFailure(FailureReason.ACCESS_DENIED, "来源请求或重定向超出允许的站点范围")
        self.permit(self.source, request.url.host)
        # 等待主进程许可期间可能发生取消或耗尽时间，真正发请求前再次核对。
        if self.cancelled.is_set():
            raise Cancelled()
        if time.monotonic() >= self.deadline:
            raise SourceFailure(FailureReason.BUDGET, "本次来源查询已达到时间预算")
        if self.verify_dns and not resolves_publicly(request.url.host):
            raise SourceFailure(FailureReason.NETWORK, "无法解析来源的公网地址")
        self.count += 1

    def request(self, method: str, url: str, *, config: SiteConfig, body=None, headers=None, limit=None, fingerprint=False, prefix=False):
        try:
            transport = self.transport
            if fingerprint or self.fingerprint:
                if self.fingerprinted is None:
                    from nectisse_worker.follow_transport import GuardedCurlTransport
                    self.fingerprinted = GuardedCurlTransport(self.guard, self.proxy)
                transport = self.fingerprinted
            request_headers = {"Referer": config.referer, **(headers or {})}
            if self.cookie and allowed_url(url, (config.domains[0],)) and not any(key.lower() == 'cookie' for key in request_headers):
                request_headers['Cookie'] = self.cookie
            response = transport(HttpRequest(method, url, request_headers, body), min(12, max(.1, self.deadline - time.monotonic())), limit or config.page_limit)
            if self.cancelled.is_set():
                raise Cancelled()
            cap = limit or config.page_limit
            if prefix:
                response = replace(response, body=response.body[:cap])
            elif len(response.body) > cap:
                raise SourceFailure(FailureReason.BUDGET, "来源响应超过本次大小上限")
            if response.status == 429:
                raw = str(response.headers.get("retry-after") or "")
                seconds = min(max(int(raw), 1), 86400) if raw.isdigit() else 60
                raise SourceFailure(FailureReason.RATE_LIMITED, "来源正在限流，请等待冷却后再试", retry_after=seconds)
            if response.status == 401 or LOGIN_PATH.search(urlsplit(response.url).path):
                raise SourceFailure(FailureReason.AUTH_REQUIRED, "来源需要登录；当前连接器仅访问公开资料")
            if CHALLENGE.search(response.body[:8192].decode('utf-8', 'ignore')):
                raise SourceFailure(FailureReason.CHALLENGE, "来源要求浏览器验证；当前来源未接入验证流程")
            if response.status == 403:
                raise SourceFailure(FailureReason.ACCESS_DENIED, "来源拒绝访问，可能与出口或地区限制有关")
            if b'country where your internet is located' in response.body[:100000] or '禁止了你的網路所在國家' in response.body[:100000].decode('utf-8', 'ignore'):
                raise SourceFailure(FailureReason.REGION, '来源限制当前出口所在地区，请调整代理出口')
            if response.status in (404, 410):
                raise SourceFailure(FailureReason.NOT_FOUND, "来源未找到该作品或作品已下架")
            if response.status >= 500:
                raise SourceFailure(FailureReason.SERVER_ERROR, "来源服务暂时不可用")
            if response.status != 200 and not (prefix and response.status == 206):
                raise SourceFailure(FailureReason.NETWORK, f"来源返回 HTTP {response.status}")
            return response
        except httpx.TimeoutException:
            failure = SourceFailure(FailureReason.TIMEOUT, "来源连接或读取超时")
            self.failures.append(failure)
            raise failure from None
        except httpx.TransportError:
            failure = SourceFailure(FailureReason.NETWORK, "未取得来源连接，请检查网络或出口")
            self.failures.append(failure)
            raise failure from None
        except SourceFailure as failure:
            self.failures.append(failure)
            raise

    def get(self, url: str, *, config: SiteConfig, headers=None, referer="") -> Page:
        response = self.request("GET", url, config=config, headers={**({'Referer': referer} if referer else {}), **(headers or {})})
        return Page(response.url, response.body)

    def wiki_get(self, url):
        config = SiteConfig(self.source, self.source, self.source, 'https://seesaawiki.jp', ('seesaawiki.jp',), 'community')
        return self.get(url, config=config)

    def post(self, url: str, *, config: SiteConfig, body: bytes, headers=None) -> Page:
        response = self.request("POST", url, config=config, body=body, headers=headers)
        return Page(response.url, response.body)

    def close(self):
        self.client.close()
        if self.fingerprinted:
            self.fingerprinted.close()
