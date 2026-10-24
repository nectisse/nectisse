"""连接器、身份与请求边界测试；仅使用本地夹具，不访问真实站点。"""
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path

import httpx
from PIL import Image
from peach_core.sources.dmm import DmmSource, matching_cids
from peach_core.sources.r18dev import R18DevSource, with_japanese, english_only
from peach_core.sources.fc2 import Fc2Source
from nectisse_worker.metadata.base import Page, SourceFailure, Cancelled
from nectisse_worker.metadata.network import NetworkSession
from nectisse_worker.metadata.query import normalize, query
from nectisse_worker.metadata.cover import fetch_cover, probe_cover, webp_size, PROBE_BYTES
from nectisse_worker.metadata.cover_candidates import cover_urls
from nectisse_worker.metadata.dmm import VerifiedDmmSource


def dmm_item(cid="ssis00057"):
    return {"id": cid, "makerContentId": "SSIS-057", "title": "作品資料テスト", "description": "紹介文",
            "makerReleasedAt": "2021-05-06T15:00:00Z", "maker": {"name": "制作元"},
            "actresses": [{"id": "1", "name": "出演者"}], "directors": [{"name": "監督"}],
            "genres": [{"name": "記録"}], "packageImage": {"largeUrl": "https://pics.dmm.co.jp/digital/video/ssis00057/ssis00057pl.jpg"}}


class MetadataTests(unittest.TestCase):
    def test_removed_fc2cmadb_cannot_dispatch_requests(self):
        session = self.session(lambda request: self.fail('retired source dispatched a request'))
        with self.assertRaises(SourceFailure) as caught:
            query({'source': 'fc2cmadb', 'kind': 'code', 'code': 'FC2-PPV-1234567'}, session)
        self.assertEqual(caught.exception.reason.value, 'unsupported')
        self.assertEqual(session.count, 0)

    def session(self, handler, permit=lambda *args: None):
        result = NetworkSession("dmm", ("dmm.co.jp",), threading.Event(), permit,
                                client=httpx.Client(transport=httpx.MockTransport(handler)), verify_dns=False)
        self.addCleanup(result.close)
        return result

    def test_dmm_identity_roles_date_and_false_positive(self):
        adapter = VerifiedDmmSource()
        item = dmm_item()
        result = normalize(adapter.parse(Page(adapter.content_url(item["id"]), json.dumps(item).encode()), "SSIS-057"))
        self.assertEqual(result["releaseDate"], "2021-05-07")
        self.assertEqual([person["role"] for person in result["people"]], ["performer", "director"])
        self.assertEqual(len(result["covers"]), 3)
        with self.assertRaises(SourceFailure):
            adapter.parse(Page(adapter.content_url("ssis00570"), json.dumps(dmm_item("ssis00570")).encode()), "SSIS-057")
        self.assertEqual(matching_cids("SSIS-057", ["ssis00570", "ssis00057", "ssis00579"]), ["ssis00057"])

    def test_r18_current_cover_shape_ignores_whitespace_and_falls_back_language(self):
        raw = {"content_id": "ssis00057", "title": "English source title", "images": {"jacket_image": {"large": " ", "large2": "https://pics.dmm.co.jp/digital/video/ssis00057/ssis00057pl.jpg"}}}
        record = R18DevSource().parse(Page("https://r18.dev/example", json.dumps(raw).encode()), "SSIS-057")
        result = normalize(english_only(record))
        self.assertEqual(result["titleLanguage"], "en")
        self.assertEqual(result["title"], raw["title"])
        self.assertEqual(len(result["covers"]), 3)
        self.assertTrue(result["warnings"])
        japanese = with_japanese(record, {"content_id": "ssis00057", "title_ja": "日文原題", "actresses": [{"name_kanji": "原名", "id": 7}]})
        self.assertEqual(normalize(japanese)["people"][0]["name"], "原名")
        self.assertEqual(with_japanese(record, {"content_id": "ssis00570", "title_ja": "別作品"}).title, "")

    def test_fc2_seller_is_not_performer_and_sku_must_match(self):
        product = {"@type": "Product", "sku": "1234567", "name": "投稿タイトル", "description": "告知文", "brand": {"url": "https://adult.contents.fc2.com/users/example/"}, "image": {"url": "https://storage1.contents.fc2.com/file/cover.jpg"}}
        html = '<script type="application/ld+json">' + json.dumps(product) + '</script><div class="items_article_headerInfo"><a href="/users/example/">投稿者</a></div>販売日：2026/10/20'
        page = Page("https://adult.contents.fc2.com/article/1234567/", html.encode())
        result = normalize(Fc2Source().parse(page, "FC2-PPV-1234567"))
        self.assertEqual(result["studio"], "")
        self.assertEqual(result["seller"], "投稿者")
        self.assertEqual([person["role"] for person in result["people"]], ["seller"])
        with self.assertRaises(SourceFailure):
            Fc2Source().parse(page, "FC2-PPV-7654321")
        with self.assertRaises(SourceFailure):
            Fc2Source().parse(page, "FC2-PPV-1234567-1")

    def test_title_search_emits_verified_candidates_with_bounded_expansion(self):
        calls = []
        def response(request):
            body = json.loads(request.content)
            calls.append(body)
            data = {"legacySearchPPV": {"result": {"contents": [{"id": "ssis00057"}, {"id": "ssis00057"}, {"id": "bad/path"}]}}} if "queryWord" in body["variables"] else {"ppvContent": dmm_item()}
            return httpx.Response(200, json={"data": data})
        emitted = []
        result = query({"source": "dmm", "kind": "title", "query": "作品"}, self.session(response), emitted.append)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["variables"]["limit"], 6)
        self.assertEqual([item["code"] for item in result], ["SSIS-057"])
        self.assertEqual(emitted, result)

    def test_redirects_are_counted_and_external_redirect_is_not_dispatched(self):
        sent = []
        permits = []
        def response(request):
            sent.append(str(request.url))
            return httpx.Response(302, headers={"location": "/second" if request.url.path == "/start" else "https://evil.example/private"})
        session = self.session(response, lambda *args: permits.append(args))
        with self.assertRaises(SourceFailure) as failure:
            session.get("https://api.video.dmm.co.jp/start", config=DmmSource().config)
        self.assertEqual(failure.exception.reason, "access_denied")
        self.assertEqual(len(sent), 2)
        self.assertEqual(len(permits), 2)

    def test_cancellation_stops_dispatch_and_rate_limit_is_not_retried(self):
        sent = []
        session = self.session(lambda request: sent.append(request) or httpx.Response(429, headers={"Retry-After": "120"}))
        with self.assertRaises(SourceFailure) as failure:
            session.get("https://api.video.dmm.co.jp/graphql", config=DmmSource().config)
        self.assertEqual(failure.exception.retry_after, 120)
        session.cancelled.set()
        with self.assertRaises(Cancelled):
            session.get("https://api.video.dmm.co.jp/graphql", config=DmmSource().config)
        self.assertEqual(len(sent), 1)

    def test_cover_identity_decode_and_dimensions_before_cache(self):
        image = io.BytesIO()
        Image.new("RGB", (800, 500), "#d6c2cb").save(image, "JPEG")
        session = self.session(lambda request: httpx.Response(200, content=image.getvalue()))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "cover.image"
            params = {"source": "dmm", "code": "SSIS-057", "url": dmm_item()["packageImage"]["largeUrl"], "destination": str(destination)}
            asset = fetch_cover(params, session)
            self.assertEqual((asset["width"], asset["height"], asset["quality"]), (800, 500, "standard"))
            self.assertEqual(asset["bytes"], destination.stat().st_size)
            with self.assertRaises(SourceFailure):
                fetch_cover({**params, "url": params["url"].replace("ssis00057", "ssis00570")}, session)
            self.assertEqual(session.count, 1)
            image.seek(0); image.truncate()
            Image.new("RGB", (100, 100)).save(image, "JPEG")
            destination.unlink()
            with self.assertRaises(SourceFailure):
                fetch_cover(params, session)
            self.assertFalse(destination.exists())

    def test_cover_probe_uses_range_and_bounds_ignored_range_response(self):
        image = io.BytesIO()
        Image.new('RGB', (2184, 1468), '#d6c2cb').save(image, 'JPEG')
        payload = image.getvalue() + b'x' * (1024 * 1024)
        consumed = []

        class Stream(httpx.SyncByteStream):
            def __iter__(self):
                for offset in range(0, len(payload), 16384):
                    consumed.append(1)
                    yield payload[offset:offset + 16384]

        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, stream=Stream())
        session = self.session(handle)
        params = {'source': 'dmm', 'code': 'SSIS-057', 'url': dmm_item()['packageImage']['largeUrl']}
        probe = probe_cover(params, session)
        self.assertEqual((probe['width'], probe['height']), (2184, 1468))
        self.assertEqual(requests[0].headers['Range'], f'bytes=0-{PROBE_BYTES - 1}')
        self.assertLess(len(consumed) * 16384, len(payload))
        self.assertLessEqual(len(consumed) * 16384, PROBE_BYTES + 16384)

    def test_partial_image_probe_and_full_image_dimension_validation(self):
        image = io.BytesIO(); Image.new('RGB', (800, 500)).save(image, 'JPEG')
        session = self.session(lambda request: httpx.Response(206 if request.headers.get('Range') else 200, content=image.getvalue()))
        with tempfile.TemporaryDirectory() as directory:
            params = {'source': 'dmm', 'code': 'SSIS-057', 'url': dmm_item()['packageImage']['largeUrl'], 'destination': str(Path(directory) / 'cover.image')}
            self.assertEqual(probe_cover(params, session)['width'], 800)
            self.assertEqual(list(Path(directory).iterdir()), [])
            with self.assertRaises(SourceFailure):
                fetch_cover({**params, 'expectedWidth': 1600, 'expectedHeight': 1000}, session)
            self.assertFalse(Path(params['destination']).exists())

    def test_large_webp_prefix_probe_and_selected_full_image_validation(self):
        import random
        image = io.BytesIO()
        pixels = random.Random(42).randbytes(800 * 537 * 3)
        Image.frombytes('RGB', (800, 537), pixels).save(image, 'WEBP', quality=95)
        body = image.getvalue()
        self.assertGreater(len(body), PROBE_BYTES)
        session = self.session(lambda request: httpx.Response(206 if request.headers.get('Range') else 200, content=body[:PROBE_BYTES] if request.headers.get('Range') else body))
        with tempfile.TemporaryDirectory() as directory:
            params = {'source': 'dmm', 'code': 'SSIS-057', 'url': dmm_item()['packageImage']['largeUrl'], 'destination': str(Path(directory) / 'cover.image')}
            self.assertEqual(probe_cover(params, session), {'width': 800, 'height': 537, 'format': 'WEBP'})
            self.assertEqual(list(Path(directory).iterdir()), [])
            asset = fetch_cover({**params, 'expectedWidth': 800, 'expectedHeight': 537}, session)
            self.assertEqual(asset['bytes'], len(body))
            self.assertEqual(Path(params['destination']).read_bytes(), body)
        # 扩展与无损头只提供尺寸；最终选图仍必须通过完整图片解码。
        extended = b'RIFF' + (100000).to_bytes(4, 'little') + b'WEBPVP8X' + (10).to_bytes(4, 'little') + b'\0' * 4 + (799).to_bytes(3, 'little') + (536).to_bytes(3, 'little')
        self.assertEqual(webp_size(extended), (800, 537))
        lossless = b'RIFF' + (100000).to_bytes(4, 'little') + b'WEBPVP8L' + (5).to_bytes(4, 'little') + b'\x2f' + (799 | (536 << 14)).to_bytes(4, 'little')
        self.assertEqual(webp_size(lossless), (800, 537))
        with self.assertRaises(ValueError):
            webp_size(extended[:20] + b'\x02' + extended[21:])
        with self.assertRaises(ValueError):
            webp_size(extended[:24])

    def test_cover_placeholder_redirect_and_unsafe_cdn_candidates_are_rejected(self):
        image = io.BytesIO(); Image.new('RGB', (800, 500)).save(image, 'JPEG')
        def handle(request):
            if request.url.path.endswith('nowprinting.jpg'):
                return httpx.Response(200, content=image.getvalue())
            return httpx.Response(302, headers={'location': 'https://pics.dmm.co.jp/nowprinting.jpg'})
        session = self.session(handle)
        params = {'source': 'dmm', 'code': 'SSIS-057', 'url': dmm_item()['packageImage']['largeUrl']}
        with self.assertRaises(SourceFailure):
            probe_cover(params, session)
        correct = params['url']
        urls = cover_urls('SSIS-057', [correct, correct, correct.replace('ssis00057', 'ssis00570'), 'https://evil.example/digital/video/ssis00057/ssis00057pl.jpg'], ('dmm.co.jp', 'dmm.com'))
        self.assertEqual(len(urls), 3)
        self.assertEqual(len(set(urls)), 3)
        self.assertTrue(all('ssis00057' in url for url in urls))
        upgraded = cover_urls('SSIS-057', [correct.replace('pl.jpg', 'thumb.jpg')], ('dmm.co.jp', 'dmm.com'))
        self.assertEqual(len(upgraded), 2)
        self.assertTrue(all(url.endswith('pl.jpg') for url in upgraded))

    def test_metadata_extraction_matches_recorded_hashes(self):
        import hashlib
        vendor = Path(__file__).parents[1] / "vendor"
        manifest = json.loads((vendor / "metadata-extraction.json").read_text())
        for entry in manifest["records"]:
            if "extractedSha256" in entry:
                self.assertEqual(hashlib.sha256((vendor / "peach_core" / entry.get("extractedPath", entry["path"])).read_bytes()).hexdigest(), entry["extractedSha256"])
