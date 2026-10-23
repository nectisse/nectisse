import hashlib
import io
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path
from PIL import Image
from peach_core.http import HttpResponse
from peach_core import javdb
from peach_core.actor_feed import parse_javdb_actor
from nectisse_worker.follow import lookup, check, identity, get, javdb_avatar, job
from nectisse_worker.metadata.base import SourceFailure


class FixtureSession:
    def __init__(self, respond):
        self.respond = respond
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((url, kwargs))
        result = self.respond(url)
        return HttpResponse(200, {}, result.encode() if isinstance(result, str) else json.dumps(result).encode(), url)


def post(key, restricted=False):
    return {"id": str(key), "title": "制作進捗とお知らせ", "user": {"name": "公開作者"}, "isRestricted": restricted, "feeRequired": 500 if restricted else 0, "publishedDatetime": "2026-10-22T12:00:00+09:00", "excerpt": "公開されている説明", "cover": {}}


class FollowTests(unittest.TestCase):
    def test_image_cache_keeps_bytes_and_respects_configured_fingerprint(self):
        output = io.BytesIO()
        Image.new('RGB', (100, 80)).save(output, 'PNG')
        payload = output.getvalue()
        for transport in ['httpx', 'fingerprint']:
            with self.subTest(transport=transport), tempfile.TemporaryDirectory() as directory:
                session = unittest.mock.Mock(count=1, failures=[])
                session.request.return_value = HttpResponse(200, {}, payload, 'https://pixiv.pximg.net/cover.png')
                target = Path(directory) / 'image'
                with patch('nectisse_worker.follow.NetworkSession', return_value=session):
                    result = job('follow.image', {'provider': 'fanbox', 'url': 'https://pixiv.pximg.net/cover.png', 'destination': str(target), 'transport': transport}, threading.Event(), lambda *args: None, lambda *args: None)
                self.assertEqual(result['status'], 'success')
                self.assertEqual(target.read_bytes(), payload)
                self.assertEqual(result['asset']['sha256'], hashlib.sha256(payload).hexdigest())
                self.assertEqual(session.request.call_args.kwargs['fingerprint'], transport == 'fingerprint')
                session.close.assert_called_once()

    def test_fanbox_profile_is_real_candidate_not_guessed_name_search(self):
        session = FixtureSession(lambda url: {"body": {"user": {"userId": "12345", "name": "公開作者"}, "description": "紹介"}})
        candidate = lookup({"provider": "fanbox", "query": "https://testcreator.fanbox.cc/"}, session)[0]
        self.assertEqual(candidate["ref"], "testcreator")
        self.assertEqual(candidate["name"], "公開作者")
        self.assertEqual(len(session.calls), 1)
        with self.assertRaises(SourceFailure):
            identity("fanbox", "表示名のような 空白")
        for url in ['https://evil.example/', 'https://user:pass@testcreator.fanbox.cc/', 'https://testcreator.fanbox.cc/posts/1']:
            with self.assertRaises(SourceFailure):
                identity("fanbox", url)

    def test_text_announcement_and_restricted_public_metadata_are_retained(self):
        def response(url):
            if 'post.listCreator' in url:
                return {"body": {"posts": [post(10), post(11, True)]}}
            return {"body": {"id": "10", "type": "text", "body": {"text": "制作進捗です。添付ファイルはありません。"}}}
        session = FixtureSession(response)
        entries = []
        result = check({"provider": "fanbox", "ref": "testcreator", "initialized": False, "seen": []}, session, entries.append)
        self.assertEqual(len(entries), 2)
        self.assertIn("制作進捗", entries[0]["summary"])
        self.assertFalse(entries[0]["partial"])
        self.assertTrue(entries[1]["restricted"])
        self.assertEqual(entries[1]["summary"], "公開されている説明")
        self.assertEqual(len(session.calls), 2)
        self.assertTrue(session.calls[1][1]['fingerprint'])
        self.assertIn("首页", result["coverage"])

    def test_incremental_boundary_uses_native_ids_not_title(self):
        session = FixtureSession(lambda url: {"body": {"posts": [post(i) for i in range(10)]}})
        entries = []
        result = check({"provider": "fanbox", "ref": "testcreator", "initialized": True, "seen": [str(i) for i in range(10)]}, session, entries.append)
        self.assertEqual(len(session.calls), 1)
        self.assertFalse(result["gap"])
        self.assertEqual(len(entries), 10)
        self.assertEqual(len({entry["externalId"] for entry in entries}), 10)

    def test_pagination_failure_preserves_streamed_first_page(self):
        def response(url):
            if 'paginateCreator' in url:
                return {"body": {"pageUrls": ['https://api.fanbox.cc/post.listCreator?creatorId=testcreator', 'https://api.fanbox.cc/post.listCreator?creatorId=another']}}
            return {"body": {"posts": [post(i, True) for i in range(10)]}}
        entries = []
        with self.assertRaises(SourceFailure):
            check({"provider": "fanbox", "ref": "testcreator", "initialized": True, "seen": ['99']}, FixtureSession(response), entries.append)
        self.assertEqual(len(entries), 10)

    def test_javdb_actor_cards_preserve_distinct_ids_and_record_types(self):
        html = '<div class="box actor-box"><a href="/actors/A123" title="演员一, 別名"><span class="info">有碼</span></a></div><div class="box actor-box"><a href="/actors/B456" title="演员一"><span class="info">無碼</span></a></div>'
        candidates = lookup({"provider": "javdb", "query": "演员一"}, FixtureSession(lambda url: html))
        self.assertEqual([item['ref'] for item in candidates], ['A123', 'B456'])
        self.assertEqual(candidates[1]['recordType'], '無碼')
        self.assertEqual(candidates[0]['aliases'], ['演员一', '別名'])

    def test_javdb_avatar_is_scoped_to_native_actor_card(self):
        html = '<div class="box actor-box"><a href="/actors/A123" title="演员一"><figure><img class="avatar" data-src="https://c0.jdbstatic.com/avatars/a/A123.jpg"></figure></a></div><div class="box actor-box"><a href="/actors/B456" title="演员一"><span class="avatar" style="background-image: url(https://c0.jdbstatic.com/avatars/b/B456.jpg)"></span><span class="info">無碼</span></a></div>'
        candidates = lookup({'provider': 'javdb', 'query': '演员一'}, FixtureSession(lambda url: html))
        self.assertTrue(candidates[0]['avatarUrl'].endswith('/A123.jpg'))
        self.assertTrue(candidates[1]['avatarUrl'].endswith('/B456.jpg'))
        self.assertEqual(javdb_avatar(html, 'Absent'), '')
        self.assertEqual(javdb_avatar(html.replace('https://c0.jdbstatic.com/', 'https://evil.example/'), 'A123'), '')

    def test_existing_actor_check_returns_profile_avatar_not_work_cover(self):
        html = '<img src="https://c0.jdbstatic.com/work.jpg"><div class="actor-avatar"><div class="image"><span class="avatar" style="background-image: url(https://c0.jdbstatic.com/avatars/a/A123.jpg)"></span></div></div><span class="actor-section-name">演员一</span><a href="/actors/A123/collect">x</a><span class="section-meta">0 部影片</span>'
        candidate = lookup({'provider': 'javdb', 'query': 'https://javdb.com/actors/A123'}, FixtureSession(lambda url: html))[0]
        result = check({'provider': 'javdb', 'ref': 'A123'}, FixtureSession(lambda url: html), lambda item: None)
        self.assertEqual(result['avatarUrl'], candidate['avatarUrl'])
        self.assertTrue(result['avatarUrl'].endswith('/A123.jpg'))

    def test_javdb_empty_profile_and_broken_page_are_different(self):
        valid = '<span class="actor-section-name">演员一</span><span class="section-meta">0 部影片</span>'
        self.assertEqual(parse_javdb_actor(valid, 'https://javdb.com/actors/A123').entries, ())
        self.assertIsNone(parse_javdb_actor(valid.replace('0 部', '20 部'), 'https://javdb.com/actors/A123'))
        self.assertEqual(javdb.search_cards('<html>broken</html>'), [])
        with self.assertRaises(SourceFailure):
            lookup({'provider': 'javdb', 'query': '演员一'}, FixtureSession(lambda url: '<html>broken</html>'))

    def test_region_restriction_is_not_an_empty_search_result(self):
        session = FixtureSession(lambda url: '<html>Due to copyright restrictions, access to this site is prohibited in the country where your internet is located.</html>')
        with self.assertRaises(SourceFailure) as failure:
            get(session, 'https://javdb.com/', {'provider': 'javdb'})
        self.assertEqual(failure.exception.reason, 'region_restricted')

    def test_extracted_modules_match_manifest(self):
        vendor = Path(__file__).parents[1] / 'vendor'
        manifest = json.loads((vendor / 'follow-extraction.json').read_text())
        for row in manifest['rows']:
            self.assertEqual(hashlib.sha256((vendor / 'peach_core' / row['target']).read_bytes()).hexdigest(), row['extractedSha256'])

    def test_actor_directory_entries_keep_release_date_code_and_native_key(self):
        html = '<span class="actor-section-name">演员一</span><a href="/actors/A123/collect">x</a><a href="/v/Work123" class="box"><div class="video-title"><strong>SSIS-057</strong> 作品資料</div><div class="meta">2026-11-01</div></a>'
        entries = []
        result = check({'provider': 'javdb', 'ref': 'A123', 'name': '演员一', 'initialized': False}, FixtureSession(lambda url: html), entries.append)
        self.assertEqual(entries[0]['externalId'], '/v/Work123')
        self.assertEqual(entries[0]['code'], 'SSIS-057')
        self.assertEqual(entries[0]['publishedAt'][:10], '2026-11-01')
        self.assertIn('初次收录', result['coverage'])

    def test_fingerprint_redirects_use_guard_and_strip_cross_origin_cookie(self):
        from nectisse_worker.follow_transport import GuardedCurlTransport
        from peach_core.http import HttpRequest
        from nectisse_worker.metadata.network import NetworkSession
        import httpx
        calls = []
        class Response:
            def __init__(self, url, status, location=None):
                self.url, self.status_code = url, status
                self.headers = {'location': location} if location else {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def iter_content(self): yield b'ok'
        class Client:
            def stream(self, method, url, **kwargs):
                calls.append((url, kwargs))
                self_outer.assertFalse(kwargs['allow_redirects'])
                return Response(url, 302, 'https://other.fanbox.cc/next') if len(calls) == 1 else Response(url, 200)
            def close(self): pass
        self_outer = self
        session = NetworkSession('fanbox', ('fanbox.cc',), threading.Event(), lambda *a: None, verify_dns=False)
        transport = GuardedCurlTransport(session.guard, ''); transport.session.close(); transport.session = Client()
        try:
            response = transport(HttpRequest('GET', 'https://api.fanbox.cc/start', {'Cookie': 'synthetic=fixture'}), 1, 100)
            self.assertEqual(response.body, b'ok')
            self.assertEqual(session.count, 2)
            self.assertNotIn('Cookie', calls[1][1]['headers'])
            with self.assertRaises(SourceFailure):
                transport(HttpRequest('GET', 'https://evil.example/path', {}), 1, 100)
            self.assertEqual(len(calls), 2)
        finally:
            transport.close(); session.close()
