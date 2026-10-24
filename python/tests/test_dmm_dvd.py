"""DMM 配信目录缺片时，从 DVD 通贩目录核对普通版身份。"""
import json
import threading
import unittest

import httpx

from nectisse_worker.metadata.base import Cancelled, SourceFailure
from nectisse_worker.metadata.network import NetworkSession
from nectisse_worker.metadata.query import query


SEARCH = '''<title>ABF-387の検索結果</title><ul id="list">
<li><p class="tmb"><a href="/mono/dvd/-/detail/=/cid=118abf3870/">別作品</a></p></li>
<li><p class="tmb"><a href="/mono/dvd/-/detail/=/cid=118tktabf387/">特典版</a></p></li>
<li><p class="tmb"><a href="/mono/dvd/-/detail/=/cid=118abf387bd/">Blu-ray</a></p></li>
<li><p class="tmb"><a href="/mono/dvd/-/detail/=/cid=118abf387/">毒づきウェイトレス 八掛うみ</a></p></li>
<li><p class="tmb"><a href="https://evil.invalid/mono/dvd/-/detail/=/cid=118abf387/">不可信地址</a></p></li>
</ul>'''
DETAIL = '''<html><head>
<link rel="canonical" href="https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=118abf387/">
<meta property="og:image" content="https://pics.dmm.co.jp/mono/movie/adult/118abf387/118abf387pl.jpg">
<meta property="og:description" content="来源实际简介。">
</head><body><h1 id="title">毒づきウェイトレス 八掛うみ</h1><table>
<tr><td>発売日：</td><td>2026/10/02</td></tr>
<tr><td>収録時間：</td><td>130分</td></tr>
<tr><td>出演者：</td><td><span id="performer"><a href="/mono/dvd/-/list/=/article=actress/id=1064982/">八掛うみ</a></span></td></tr>
<tr><td>監督：</td><td><a>チャーリー中田</a></td></tr>
<tr><td>メーカー：</td><td><a>プレステージ</a></td></tr>
<tr><td>レーベル：</td><td><a>ABSOLUTELY FANTASIA</a></td></tr>
<tr><td>シリーズ：</td><td>----</td></tr>
<tr><td>ジャンル：</td><td><a>単体作品</a> <a>コスプレ</a></td></tr>
<tr><td>品番：</td><td>118abf387</td></tr></table></body></html>'''


class DmmDvdTests(unittest.TestCase):
    def session(self, get, digital=None, cookie='', digital_status=200):
        self.sent = []

        def respond(request):
            self.sent.append(request)
            if request.method == 'POST':
                body = json.loads(request.content)
                data = {'legacySearchPPV': {'result': {'contents': []}}} if 'queryWord' in body['variables'] else {'ppvContent': digital}
                return httpx.Response(digital_status, json={'data': data})
            return get(request)

        session = NetworkSession('dmm', ('dmm.co.jp', 'dmm.com'), threading.Event(), lambda *args: None,
                                 client=httpx.Client(transport=httpx.MockTransport(respond)), verify_dns=False, cookie=cookie)
        self.addCleanup(session.close)
        return session

    def pages(self, request):
        return httpx.Response(200, text=SEARCH if '/search/' in request.url.path else DETAIL)

    def test_abf387_digital_missing_queries_dvd_and_keeps_official_cover(self):
        result = query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, self.session(self.pages))[0]
        self.assertEqual(result['code'], 'ABF-387')
        self.assertEqual(result['contentId'], '118abf387')
        self.assertEqual(result['sourceUrl'], 'https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=118abf387/')
        self.assertEqual(result['title'], '毒づきウェイトレス 八掛うみ')
        self.assertEqual(result['releaseDate'], '2026-10-02')
        self.assertEqual(result['people'][0], {'name': '八掛うみ', 'role': 'performer', 'sourceIdentity': '1064982'})
        self.assertEqual(result['studio'], 'プレステージ')
        self.assertEqual(result['series'], '')
        self.assertEqual(result['tags'], ['単体作品', 'コスプレ'])
        self.assertTrue(result['covers'][0]['url'].endswith('/118abf387/118abf387pl.jpg'))
        self.assertEqual(result['parser'], 'dmm-dvd')
        self.assertEqual(len(self.sent), 4)
        self.assertEqual(str(self.sent[-1].url), result['sourceUrl'])

    def test_digital_success_does_not_request_dvd(self):
        digital = {'id': 'abf00387', 'makerContentId': 'ABF-387', 'title': '配信作品'}
        result = query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, self.session(lambda _: self.fail('unexpected DVD request'), digital))[0]
        self.assertEqual(result['parser'], 'dmm-graphql')
        self.assertEqual(len(self.sent), 1)

    def test_digital_access_failure_does_not_start_dvd_search(self):
        session = self.session(lambda _: self.fail('unexpected DVD request'), digital_status=429)
        with self.assertRaises(SourceFailure) as caught:
            query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, session)
        self.assertEqual(caught.exception.reason, 'rate_limited')
        self.assertEqual(len(self.sent), 1)

    def test_dvd_cookie_only_adds_public_age_confirmation_preserving_session(self):
        query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, self.session(self.pages, cookie='session=existing; age_check_done=0'))
        for request in self.sent[2:]:
            self.assertEqual(request.headers['Cookie'], 'session=existing; age_check_done=1')
        self.assertEqual(self.sent[0].headers['Cookie'], 'session=existing; age_check_done=0')

    def test_dvd_does_not_follow_wrong_identity_or_special_edition(self):
        for content, reason in ((SEARCH.replace('cid=118abf387/', 'cid=118abf389/'), 'not_found'), ('<html>unexpected response</html>', 'parse_error')):
            with self.subTest(content=content[:30]):
                session = self.session(lambda _: httpx.Response(200, text=content))
                with self.assertRaises(SourceFailure) as caught:
                    query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, session)
                self.assertEqual(caught.exception.reason, reason)
                self.assertEqual(len(self.sent), 3)

    def test_dvd_detail_native_identity_redirect_and_bod_are_rejected(self):
        cases = [DETAIL.replace('<td>118abf387</td>', '<td>118abf389</td>'),
                 DETAIL.replace('cid=118abf387/', 'cid=118abf389/'),
                 DETAIL.replace('毒づきウェイトレス 八掛うみ', '毒づきウェイトレス 八掛うみ（BOD）')]
        for html in cases:
            with self.subTest(html=html[:60]):
                session = self.session(lambda request: httpx.Response(200, text=SEARCH if '/search/' in request.url.path else html))
                with self.assertRaises(SourceFailure):
                    query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, session)

    def test_dvd_failure_and_cancellation_are_not_reported_as_missing(self):
        for status, reason in ((429, 'rate_limited'), (403, 'access_denied'), (500, 'server_error')):
            with self.subTest(status=status):
                session = self.session(lambda _: httpx.Response(status))
                with self.assertRaises(SourceFailure) as caught:
                    query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, session)
                self.assertEqual(caught.exception.reason, reason)
                self.assertEqual(len(self.sent), 3)
        session = self.session(self.pages)
        session.permit = lambda *args: session.cancelled.set() if session.count == 2 else None
        with self.assertRaises(Cancelled):
            query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387'}, session)
        self.assertEqual(len(self.sent), 2)

    def test_known_physical_content_id_can_be_queried_again(self):
        session = self.session(self.pages)
        result = query({'source': 'dmm', 'kind': 'code', 'code': 'ABF-387', 'contentId': '118abf387'}, session)[0]
        self.assertEqual(result['contentId'], '118abf387')
        self.assertEqual(len(self.sent), 2)
