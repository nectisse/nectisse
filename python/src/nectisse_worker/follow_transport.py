"""指纹传输沿用 Peach/curl_cffi；每次重定向重新经过许可与域名检查。"""
from urllib.parse import urljoin, urlsplit
import httpx
from curl_cffi import requests
from curl_cffi.requests.exceptions import CurlError
from peach_core.http import HttpResponse
from .metadata.base import SourceFailure, FailureReason


class GuardedCurlTransport:
    def __init__(self, guard, proxy):
        self.guard = guard
        self.session = requests.Session(impersonate="chrome150", trust_env=False, proxy=proxy or None, verify=True, retry=0)

    def __call__(self, request, timeout, max_bytes):
        url, method, headers, body = request.url, request.method, dict(request.headers), request.body
        try:
            for _ in range(6):
                self.guard(httpx.Request(method, url))
                with self.session.stream(method, url, headers=headers, content=body, timeout=timeout, allow_redirects=False) as response:
                    status = response.status_code
                    location = response.headers.get("location")
                    if status not in {301, 302, 303, 307, 308} or not location:
                        chunks, total = [], 0
                        for chunk in response.iter_content():
                            part = chunk[:max_bytes + 1 - total]
                            chunks.append(part); total += len(part)
                            if total > max_bytes:
                                break
                        return HttpResponse(status, dict(response.headers), b"".join(chunks), str(response.url))
                    target = urljoin(url, location)
                if urlsplit(target).netloc != urlsplit(url).netloc:
                    headers = {key: value for key, value in headers.items() if key.lower() not in {"cookie", "authorization"}}
                if status == 303 or (status in {301, 302} and method not in {"GET", "HEAD"}):
                    method, body = "GET", None
                url = target
        except CurlError:
            raise SourceFailure(FailureReason.NETWORK, "来源指纹连接失败，请检查出口、Cookie 或稍后重试") from None
        raise SourceFailure(FailureReason.BUDGET, "来源重定向次数超过预算")

    def close(self):
        self.session.close()
