"""复用边界回归测试：不访问网络，不依赖 Peach 主服务或本地媒体。"""

import hashlib
import unittest
from pathlib import Path

import httpx
from peach_core import http
from peach_core.catalog_rules import normalise_code_key


class ReuseTests(unittest.TestCase):
    def test_vendored_files_match_recorded_upstream(self):
        expected = {
            "http.py": "588efcd9b90c00b731a0d2fe0df3ef18791e7ce6b30c0129bbc335b0d80d2be4",
            "user_agent.py": "a934b84f8e6e19c34132802ad2cd4dcd796d3e2459314af24958c6141a2e8daa",
            "catalog_rules.py": "7731338323b786663991a90e3010f246c1f5a9c2165a0094ee24ae3189531b59",
        }
        for name, digest in expected.items():
            with self.subTest(name=name):
                self.assertEqual(
                    hashlib.sha256(
                        Path(http.__file__).with_name(name).read_bytes()
                    ).hexdigest(),
                    digest,
                )

    def test_same_origin_redirect_keeps_cookie_cross_origin_removes_it(self):
        seen = []

        def handle(request):
            seen.append(request)
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "/next"})
            if request.url.path == "/next":
                return httpx.Response(
                    302, headers={"location": "https://other.example/end"}
                )
            return httpx.Response(200, content=b"ok")

        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            result = http.HttpxTransport(client)(
                http.HttpRequest(
                    "GET",
                    "https://source.example/start",
                    {"Cookie": "session=fake", "Authorization": "fake"},
                ),
                timeout=1,
                max_bytes=100,
            )
        self.assertEqual(result.url, "https://other.example/end")
        self.assertEqual(seen[1].headers["cookie"], "session=fake")
        self.assertNotIn("cookie", seen[2].headers)
        self.assertNotIn("authorization", seen[2].headers)

    def test_large_response_stops_at_limit_plus_sentinel(self):
        with httpx.Client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, content=b"x" * 100)
            )
        ) as client:
            result = http.HttpxTransport(client)(
                http.HttpRequest("GET", "https://source.example", {}), 1, 8
            )
        self.assertEqual(result.body, b"x" * 9)

    def test_declared_japanese_encoding_survives_reuse(self):
        text = '<meta charset="euc-jp">作品資料'
        self.assertEqual(http.body_text(text.encode("euc-jp")), text)

    def test_identifier_matching_preserves_different_work_numbers(self):
        self.assertEqual(normalise_code_key("FC2-PPV-1234567"), "FC2-PPV-1234567")
        self.assertNotEqual(
            normalise_code_key("259LUXU-891"), normalise_code_key("259LUXU-1891")
        )

    def test_both_native_transports_load_without_network(self):
        standard = http.HttpxTransport()
        fingerprinted = http.CurlCffiTransport(impersonate="chrome150")
        standard.close()
        fingerprinted.close()


if __name__ == "__main__":
    unittest.main()
