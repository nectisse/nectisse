"""FC2PPV-DB 的有界浏览器会话，复用 Peach 的 CDP、验证和年龄门流程。"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from peach_core import browser_transport as upstream
from peach_core.http import HttpRequest
from .metadata.base import Cancelled, FailureReason, Page, Session, SourceFailure, challenge_page
from .metadata.network import allowed_url

DOMAIN = "fc2ppv-db.com"
GATES = {DOMAIN: {"path": "/age-verify", "button": r"18|はい|入場|同意|以上|Enter|Yes"}}


class ManagedBrowser(upstream._Browser):
    def evaluate(self, expression, *, timeout=30.0):
        if expression == upstream._DOCUMENT_SCRIPT:
            expression = expression.replace("document.documentElement.outerHTML", "document.documentElement.outerHTML.slice(0, 2097153)")
        return super().evaluate(expression, timeout=timeout)

    def navigate(self, url, *, referrer=None):
        params = {"url": url, **({"referrer": referrer} if referrer else {})}
        result = self.socket.call("Page.navigate", **params)
        error = str(result.get("errorText") or "")
        if error and error != "net::ERR_ABORTED":
            reason = error if error.startswith("net::ERR_") and len(error) < 80 else "导航失败"
            failure = SourceFailure(FailureReason.NETWORK, f"浏览器无法打开 FC2PPV-DB（{reason}），请检查代理出口")
            self.owner.session.failure = failure
            raise failure

    def start(self):
        super().start()
        self.socket.event_handler = self.on_event
        self.target_id = self.socket.call("Target.getTargetInfo")["targetInfo"]["targetId"]
        self.socket.call("Target.setDiscoverTargets", discover=True)
        self.socket.call("Browser.setDownloadBehavior", behavior="deny")
        self.socket.call("Fetch.enable", patterns=[{"urlPattern": "*", "requestStage": "Request"}])

    def on_event(self, message):
        if message.get("method") == "Target.targetCreated":
            target = message["params"]["targetInfo"]
            if target.get("type") == "page" and target.get("targetId") != self.target_id:
                self.socket.next_id += 1
                self.socket.send(json.dumps({"id": self.socket.next_id, "method": "Target.closeTarget", "params": {"targetId": target["targetId"]}}))
            return
        if message.get("method") != "Fetch.requestPaused":
            return
        params = message["params"]
        request = params["request"]
        try:
            allowed = self.owner.check_request(request["url"], params.get("resourceType", ""))
        except (SourceFailure, Cancelled) as error:
            if isinstance(error, SourceFailure):
                self.owner.session.failure = error
            self.socket.next_id += 1
            self.socket.send(json.dumps({"id": self.socket.next_id, "method": "Fetch.failRequest", "params": {"requestId": params["requestId"], "errorReason": "BlockedByClient"}}))
            raise
        self.socket.next_id += 1
        self.socket.send(json.dumps({"id": self.socket.next_id, "method": "Fetch.continueRequest" if allowed else "Fetch.failRequest", "params": {"requestId": params["requestId"], **({} if allowed else {"errorReason": "BlockedByClient"})}}))


class Transport(upstream.BrowserTransport):
    def __init__(self, executable, profile, flags):
        super().__init__(executable, profile, flags, gates=GATES, sleep=self.pause)
        self.session = None
        self.progress = lambda payload: None

    def pause(self, seconds):
        if self.session is not None:
            self.session.check()
            if self.session.cancelled.wait(seconds):
                raise Cancelled()
            self.session.check()
        else:
            time.sleep(seconds)

    def _ensure(self):
        if self._browser is None or not self._browser.alive():
            self._drop()
            self.progress({"event": "browser", "phase": "starting", "message": "正在启动 FC2PPV-DB 独立浏览器会话"})
            browser = ManagedBrowser(self.executable, self.profile, self.flags, sleep=self.pause)
            browser.owner = self
            self._browser = browser
            try:
                browser.start()
            except Exception:
                self._drop()
                raise
            self.progress({"event": "browser", "phase": "session", "browserPid": browser.process.pid, "message": "浏览器会话已就绪"})
        else:
            self.progress({"event": "browser", "phase": "reused", "browserPid": self._browser.process.pid, "message": "正在复用 FC2PPV-DB 浏览器会话"})
        return self._browser

    def check_request(self, url, resource_type):
        if url == "about:blank":
            return True
        if self.session is None:
            return False
        if self.session.closing:
            return False
        self.session.check()
        # 验证 iframe 与脚本来自 Cloudflare；其他站点的导航、协议及下载一律不放行。
        if not allowed_url(url, (DOMAIN, "challenges.cloudflare.com", "static.cloudflareinsights.com")):
            if resource_type != "Document":
                return False
            raise SourceFailure(FailureReason.ACCESS_DENIED, "浏览器请求离开 FC2PPV-DB 或验证服务范围")
        self.session.subrequests += 1
        if self.session.subrequests > 160:
            raise SourceFailure(FailureReason.BUDGET, "浏览器页面子请求超过本次预算")
        if resource_type == "Document":
            self.session.navigation(url)
        return True

    def _state(self, browser):
        self.session.check()
        try:
            state = json.loads(browser.evaluate(upstream._STATE_SCRIPT))
        except SourceFailure:
            raise
        except RuntimeError:
            return {"title": "", "ready": "loading", "url": "", "head": ""}
        challenged = any(mark in state.get("head", "") or mark in state.get("title", "") for mark in upstream.CHALLENGE_MARKS)
        if challenged and not self.session.challenged:
            self.session.challenged = True
            self.progress({"event": "browser", "phase": "verifying", "message": "正在等待 FC2PPV-DB 浏览器验证；需要操作时会打开验证窗口"})
        return state

    def _load(self, browser, url, headers, timeout):
        place = browser.place
        def place_with_feedback(*, visible):
            if visible:
                self.progress({"event": "browser", "phase": "attention", "message": "请在打开的浏览器窗口中完成 FC2PPV-DB 验证；也可以取消查询"})
            place(visible=visible)
        browser.place = place_with_feedback
        try:
            return super()._load(browser, url, headers, timeout)
        finally:
            browser.place = place


class BrowserSession(Session):
    def __init__(self, transport, cancelled, permit, progress):
        self.transport = transport
        self.cancelled = cancelled
        self.permit = permit
        self.deadline = time.monotonic() + 210
        self.count = 0
        self.subrequests = 0
        self.challenged = False
        self.failure = None
        self.closing = False
        self.failures = []
        self.transport.session = self
        self.transport.progress = progress
        # 每次都是用户主动查询；上次未完成验证不能永久阻止再次打开验证窗口。
        self.transport._unsolved.clear()

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled()
        if time.monotonic() >= self.deadline:
            raise SourceFailure(FailureReason.TIMEOUT, "FC2PPV-DB 浏览器验证超时，可重新查询")

    def navigation(self, url):
        self.check()
        if self.count >= 16:
            raise SourceFailure(FailureReason.BUDGET, "浏览器导航、重定向与验证重载已达到 16 次预算")
        self.permit("fc2ppvdb", urlsplit(url).hostname)
        self.check()
        self.count += 1

    def get(self, url, *, config, headers=None, referer=""):
        if not allowed_url(url, (DOMAIN,)):
            raise SourceFailure(FailureReason.ACCESS_DENIED, "浏览器只读取 FC2PPV-DB 作品页")
        self.check()
        try:
            response = self.transport(HttpRequest("GET", url, {"Referer": referer or config.referer, **(headers or {})}), min(40, self.deadline - time.monotonic()), config.page_limit)
        except upstream.ChallengeUnsolved:
            raise SourceFailure(FailureReason.CHALLENGE, "浏览器验证未完成，可重新查询后在验证窗口操作", retry_after=300) from None
        except upstream.PageTimeout:
            raise SourceFailure(FailureReason.TIMEOUT, "FC2PPV-DB 页面读取超时") from None
        except upstream.BrowserUnavailable:
            if self.failure is not None:
                raise self.failure
            raise SourceFailure(FailureReason.NETWORK, "FC2PPV-DB 浏览器会话断开，可重新查询") from None
        self.check()
        if not allowed_url(response.url, (DOMAIN,)):
            if urlsplit(response.url).scheme in {"about", "chrome-error"}:
                raise SourceFailure(FailureReason.NETWORK, "FC2PPV-DB 未返回站点页面，浏览器可能停留在网络错误页")
            raise SourceFailure(FailureReason.ACCESS_DENIED, "浏览器最终页面不属于 FC2PPV-DB")
        if len(response.body) > config.page_limit:
            raise SourceFailure(FailureReason.BUDGET, "FC2PPV-DB 页面超过 2 MiB 上限")
        if challenge_page(response.body):
            raise SourceFailure(FailureReason.CHALLENGE, "FC2PPV-DB 验证尚未通过")
        if response.status == 429:
            raise SourceFailure(FailureReason.RATE_LIMITED, "FC2PPV-DB 正在限流，请稍后重试", retry_after=60)
        if response.status in (404, 410):
            raise SourceFailure(FailureReason.NOT_FOUND, "FC2PPV-DB 未找到该作品")
        if response.status == 401:
            raise SourceFailure(FailureReason.AUTH_REQUIRED, "FC2PPV-DB 需要重新完成验证或登录")
        if response.status >= 500:
            raise SourceFailure(FailureReason.SERVER_ERROR, "FC2PPV-DB 服务暂时不可用")
        if response.status != 200:
            raise SourceFailure(FailureReason.ACCESS_DENIED, f"FC2PPV-DB 返回 HTTP {response.status}")
        return Page(response.url, response.body)

    def close(self):
        # 不把活跃页面留在后台继续轮询；Cookie 和独立 profile 保留。
        self.closing = True
        if self.transport._browser is not None:
            try:
                self.transport._browser.navigate("about:blank")
                self.transport._browser.place(visible=False)
            except (OSError, RuntimeError):
                self.transport._drop()
        self.transport.session = None
        self.transport.progress = lambda payload: None


class BrowserPool:
    def __init__(self, profile: Path):
        self.profile = profile
        self.transport = None
        self.flags = None

    def acquire(self, proxy):
        parsed = urlsplit(proxy)
        if proxy and (parsed.scheme not in {"http", "https", "socks5", "socks5h"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise SourceFailure(FailureReason.NETWORK, "浏览器代理地址格式不支持")
        proxy = proxy.replace("socks5h://", "socks5://", 1)
        flags = upstream.proxy_flags(direct=not proxy, proxy=proxy)
        flags = (*flags, "--remote-debugging-address=127.0.0.1", "--disable-extensions")
        if self.transport is not None and flags != self.flags:
            self.close()
        if self.transport is None:
            executable = upstream.find_browser(environ={})
            if not executable:
                raise SourceFailure(FailureReason.UNSUPPORTED, "FC2PPV-DB 验证需要本机 Chrome 或 Edge，未找到可用浏览器")
            try:
                self.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.chmod(self.profile, 0o700)
            except OSError:
                raise SourceFailure(FailureReason.UNSUPPORTED, "浏览器会话目录无法写入，请检查应用数据目录权限") from None
            self.transport = Transport(executable, self.profile, flags)
            self.flags = flags
        return self.transport

    def close(self):
        if self.transport is not None:
            self.transport.close()
            self.transport = None
