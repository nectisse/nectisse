import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from peach_core.http import HttpResponse
from nectisse_worker.browser_session import BrowserPool, BrowserSession, Transport, ManagedBrowser, DOMAIN
from nectisse_worker.metadata.base import Cancelled, SourceFailure
from peach_core.sources.fc2ppvdb import FC2PPVDB, Fc2ppvdbSource

URL = f"https://{DOMAIN}/ja/videos/4898837"


class BrowserSessionTests(unittest.TestCase):
    def session(self):
        transport = Transport("unused", Path("unused"), ())
        session = BrowserSession(transport, threading.Event(), Mock(), Mock())
        self.addCleanup(transport.close)
        return session

    def test_pool_reuses_same_profile_and_proxy_and_restarts_after_route_change(self):
        with tempfile.TemporaryDirectory() as directory, patch("nectisse_worker.browser_session.upstream.find_browser", return_value="/browser"), patch("nectisse_worker.browser_session.Transport") as factory:
            factory.side_effect = lambda *args: Mock()
            pool = BrowserPool(Path(directory) / "profile")
            first = pool.acquire("http://127.0.0.1:7890")
            self.assertIs(first, pool.acquire("http://127.0.0.1:7890"))
            self.assertIsNot(first, pool.acquire(""))
            first.close.assert_called_once()
            self.assertIn("--no-proxy-server", factory.call_args.args[2])
            self.assertEqual(pool.profile.stat().st_mode & 0o777, 0o700)
            pool.close()

    def test_no_browser_is_explicit_and_no_silent_fingerprint_fallback(self):
        with patch("nectisse_worker.browser_session.upstream.find_browser", return_value=None):
            with self.assertRaises(SourceFailure) as caught:
                BrowserPool(Path("unused")).acquire("")
            self.assertEqual(caught.exception.reason.value, "unsupported")

    def test_partial_start_failure_always_closes_owned_browser(self):
        session = self.session()
        with patch("nectisse_worker.browser_session.ManagedBrowser") as factory:
            factory.return_value.start.side_effect = OSError("CDP unavailable")
            with self.assertRaises(OSError):
                session.transport._ensure()
            factory.return_value.close.assert_called_once()
            self.assertIsNone(session.transport._browser)

    def test_navigation_permits_every_redirect_and_bounds_all_requests(self):
        session = self.session()
        transport = session.transport
        self.assertTrue(transport.check_request(URL, "Document"))
        self.assertTrue(transport.check_request("https://challenges.cloudflare.com/turnstile/frame", "Document"))
        self.assertTrue(transport.check_request(f"https://{DOMAIN}/_next/app.js", "Script"))
        self.assertFalse(transport.check_request("https://analytics.invalid/track.js", "Script"))
        self.assertEqual(session.count, 2)
        self.assertEqual(session.subrequests, 3)
        self.assertEqual(session.permit.call_count, 2)
        with self.assertRaises(SourceFailure):
            transport.check_request("https://evil.invalid/", "Document")
        with self.assertRaises(SourceFailure):
            transport.check_request(f"http://{DOMAIN}/", "Document")
        session.count = 16
        with self.assertRaises(SourceFailure) as caught:
            transport.check_request(URL, "Document")
        self.assertEqual(caught.exception.reason.value, "budget_exceeded")
        session.count = 0
        session.subrequests = 160
        with self.assertRaises(SourceFailure):
            transport.check_request(f"https://{DOMAIN}/app.js", "Script")

    def test_cancel_deadline_and_budget_cannot_be_swallowed_as_page_loading(self):
        session = self.session()
        browser = Mock()
        session.cancelled.set()
        with self.assertRaises(Cancelled):
            session.transport._state(browser)
        browser.evaluate.assert_not_called()
        session.cancelled.clear()
        session.deadline = time.monotonic() - 1
        with self.assertRaises(SourceFailure):
            session.transport._state(browser)
        session.deadline = time.monotonic() + 5
        browser.evaluate.side_effect = SourceFailure("budget_exceeded", "quota")
        with self.assertRaises(SourceFailure):
            session.transport._state(browser)

    def test_fetch_interception_fails_denied_navigation_before_dispatch(self):
        session = self.session()
        browser = ManagedBrowser("unused", Path("unused"), ())
        browser.owner = session.transport
        browser.socket = SimpleNamespace(next_id=0, send=Mock())
        with self.assertRaises(SourceFailure):
            browser.on_event({"method": "Fetch.requestPaused", "params": {"requestId": "blocked", "resourceType": "Document", "request": {"url": "https://evil.invalid/"}}})
        message = json.loads(browser.socket.send.call_args.args[0])
        self.assertEqual(message["method"], "Fetch.failRequest")
        self.assertEqual(session.failure.reason.value, "access_denied")
        session.permit.assert_not_called()

    def test_response_size_origin_and_errors_checked_before_parse(self):
        session = self.session()
        for response, reason in [
            (HttpResponse(200, {}, b"x", "https://evil.invalid/"), "access_denied"),
            (HttpResponse(200, {}, b"x" * (FC2PPVDB.page_limit + 1), URL), "budget_exceeded"),
            (HttpResponse(429, {}, b"", URL), "rate_limited"),
            (HttpResponse(404, {}, b"", URL), "not_found"),
            (HttpResponse(401, {}, b"", URL), "auth_required"),
            (HttpResponse(503, {}, b"", URL), "server_error"),
            (HttpResponse(200, {}, b"<title>Just a moment</title>", URL), "challenge"),
        ]:
            with patch.object(Transport, "__call__", return_value=response), self.assertRaises(SourceFailure) as caught:
                session.get(URL, config=FC2PPVDB)
            self.assertEqual(caught.exception.reason.value, reason)

    def test_parser_keeps_fc2_identity_and_no_cover(self):
        session = self.session()
        body = b"<main><h1>FC2-PPV-4898837 Test</h1><p>nothing else</p></main>"
        with patch.object(Transport, "__call__", return_value=HttpResponse(200, {}, body, URL)):
            record = Fc2ppvdbSource().query("FC2-PPV-4898837", session=session)
            self.assertEqual(record.title, "Test")
            self.assertEqual(list(record.cover_urls), [])
            with self.assertRaises(SourceFailure):
                Fc2ppvdbSource().query("FC2-PPV-48988370", session=session)


if __name__ == "__main__":
    unittest.main()
