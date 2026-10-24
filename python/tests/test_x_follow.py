import copy
import json
import threading
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import httpx
from peach_core.http import HttpResponse
from nectisse_worker.follow import CONFIGS, job
from nectisse_worker.follow_x import check, identity, lookup
from nectisse_worker.metadata.base import FailureReason, SourceFailure
from nectisse_worker.metadata.network import NetworkSession

REF = '1722511982610538496'
POST = '2113542950370304375'
CONFIG = CONFIGS['x']
CHECKED = '2026-10-24T00:00:00Z'


def user(handle='creator_1', **extra):
    return {'code': 200, 'user': {'id': REF, 'screen_name': handle, 'name': '原创作者', 'description': '个人简介', 'protected': False, 'statuses': 20, 'avatar_url': '', **extra}}


def post(key=POST, handle='creator_1', **extra):
    return {'type': 'status', 'id': key, 'url': f'https://x.com/{handle}/status/{key}', 'author': {'id': REF, 'screen_name': handle, 'name': '原创作者'}, 'text': '原创正文\n第二行', 'created_timestamp': 1792800000, 'replying_to': None, 'reposted_by': None, **extra}


def page(rows, bottom=None):
    return {'code': 200, 'results': rows, 'cursor': {'top': None, 'bottom': bottom}}


def params(**extra):
    return {'provider': 'x', 'ref': REF, 'initialized': False, **extra}


class Session:
    def __init__(self, responder, profile=None):
        self.responder = responder
        self.profile = profile or user()
        self.calls = []
        self.count = 0
        self.failures = []
        self.closed = False

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        self.count += 1
        payload = self.responder(url) if urlsplit(url).path.endswith('/statuses') else self.profile
        return HttpResponse(200, {}, json.dumps(payload).encode(), url)

    def close(self):
        self.closed = True


class XFollowTests(unittest.TestCase):
    def test_inputs_resolve_exact_account_without_post_or_search_requests(self):
        for value in ['creator_1', '@Creator_1', 'https://x.com/Creator_1?ref_src=share', 'https://twitter.com/creator_1/']:
            self.assertEqual(identity(value), 'creator_1')
            session = Session(lambda url: self.fail('身份查询不应请求时间线'))
            candidate = lookup({'query': value}, session, CONFIG)[0]
            self.assertEqual(candidate['ref'], REF)
            self.assertIsInstance(candidate['ref'], str)
            self.assertEqual(candidate['handle'], 'creator_1')
            self.assertEqual(candidate['url'], 'https://x.com/creator_1')
            self.assertEqual(session.calls[0][1], 'https://api.fxtwitter.com/2/profile/creator_1')
            self.assertEqual(session.calls[0][2]['headers'], {'Accept': 'application/json'})
        for value in ['https://x.com/creator_1/status/123', 'https://x.com/search?q=test', 'https://evil.example/creator_1', 'http://x.com/creator_1', 'https://u:p@x.com/creator_1', 'https://x.com:8443/creator_1', '@@creator_1', 'display name', 'https://x.com/i/lists/123']:
            with self.subTest(value=value), self.assertRaises(SourceFailure):
                identity(value)

    def test_profile_requires_matching_public_string_identity(self):
        for change in [{'id': int(REF)}, {'id': '123'}, {'protected': True}, {'protected': None}]:
            session = Session(lambda url: page([]), user(**change))
            with self.subTest(change=change), self.assertRaises(SourceFailure):
                check(params(), session, lambda entry: None, CONFIG)
        session = Session(lambda url: page([]), user(handle='somebody_else'))
        with self.assertRaises(SourceFailure):
            lookup({'query': 'creator_1'}, session, CONFIG)

    def test_profile_avatar_uses_cacheable_size_without_leaving_its_image_host(self):
        session = Session(lambda url: page([]), user(avatar_url='https://pbs.twimg.com/profile_images/123/avatar_normal.jpg?x=1'))
        candidate = lookup({'query': 'creator_1'}, session, CONFIG)[0]
        self.assertEqual(candidate['avatarUrl'], 'https://pbs.twimg.com/profile_images/123/avatar_200x200.jpg?x=1')
        session = Session(lambda url: page([]), user(avatar_url='https://pbs.twimg.com.evil.example/profile_images/123/avatar_normal.jpg'))
        self.assertEqual(lookup({'query': 'creator_1'}, session, CONFIG)[0]['avatarUrl'], '')

    def test_only_original_posts_are_published_before_media_is_considered(self):
        rows = [
            post(),
            post('2113542950370304376', replying_to={'screen_name': 'other'}),
            post('2113542950370304377', replying_to={'screen_name': 'creator_1'}),
            post('2113542950370304378', quote={'type': 'status', 'text': '引用正文'}),
            post('2113542950370304379', quote={'type': 'tombstone', 'reason': 'unavailable'}),
            post('2113542950370304380', reposted_by={'id': REF}),
            post('2113542950370304381', author={'id': '123', 'screen_name': 'other'}, reposted_by={'id': REF}),
            post('2113542950370304382', author={'id': '123', 'screen_name': 'other'}),
            post('2113542950370304383', text='', media={'all': [{'type': 'photo', 'url': 'https://pbs.twimg.com/media/image.jpg?name=orig'}]}),
        ]
        entries = []
        result = check(params(), Session(lambda url: page(rows)), entries.append, CONFIG)
        self.assertEqual([row['externalId'] for row in entries], [POST, '2113542950370304383'])
        self.assertEqual(entries[0]['summary'], '原创正文\n第二行')
        self.assertEqual(entries[0]['postKind'], 'original')
        self.assertEqual(entries[0]['authorRef'], REF)
        self.assertEqual(entries[0]['publishedPrecision'], 'exact')
        self.assertEqual(entries[1]['thumbnailUrl'], 'https://pbs.twimg.com/media/image.jpg?name=orig')
        self.assertFalse(result['gap'])
        # 被范围过滤的帖子仅作为观察窗口，不会被转成动态或图片任务。
        self.assertEqual(len(result['xSyncState']['windowIds']), 8)

    def test_no_reply_quote_detail_or_media_index_endpoints_are_requested(self):
        session = Session(lambda url: page([post(replying_to={'screen_name': 'creator_1'})], 'next'))
        entries = []
        result = check(params(), session, entries.append, CONFIG)
        self.assertEqual(entries, [])
        self.assertIn('没有可收录的原创帖', result['coverage'])
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(parse_qs(urlsplit(session.calls[1][1]).query), {'count': ['20']})
        self.assertTrue(all(urlsplit(call[1]).hostname == 'api.fxtwitter.com' for call in session.calls))

    def test_profile_rename_keeps_numeric_identity_and_uses_id_requests(self):
        session = Session(lambda url: page([post(handle='renamed')]), user(handle='renamed'))
        entries = []
        result = check(params(), session, entries.append, CONFIG)
        self.assertEqual(result['profile']['ref'], REF)
        self.assertEqual(result['profile']['handle'], 'renamed')
        self.assertEqual(result['profile']['url'], 'https://x.com/renamed')
        self.assertEqual(entries[0]['url'], f'https://x.com/renamed/status/{POST}')
        self.assertIn('/profile/id:' + REF, session.calls[0][1])

    def test_overlapping_pages_are_deduplicated_and_not_stopped_at_one_old_post(self):
        old = '2113542950370304374'
        second = '2113542950370304373'
        session = Session(lambda url: page([post(old), post()], 'second') if 'cursor=' not in url else page([post(), post(second)], 'third'))
        entries = []
        result = check(params(initialized=True, xSyncState={'windowIds': [old, second], 'checkedAt': CHECKED}), session, entries.append, CONFIG)
        self.assertEqual(len(session.calls), 3)
        self.assertEqual([row['externalId'] for row in entries], [old, POST, second])
        self.assertFalse(result['gap'])
        self.assertEqual(result['xSyncState']['windowIds'], [old, POST])

    def test_repeat_page_and_repeat_cursor_stop_without_advancing_window(self):
        for mode in ['page', 'cursor']:
            def respond(url):
                return page([post()], 'second') if 'cursor=' not in url or mode == 'page' else page([post('2113542950370304373')], 'second')
            entries = []
            session = Session(respond)
            result = check(params(initialized=True, xSyncState={'windowIds': ['123', '124'], 'checkedAt': CHECKED}), session, entries.append, CONFIG)
            self.assertEqual(result['status'], 'partial')
            self.assertTrue(result['gap'])
            self.assertNotIn('xSyncState', result)
            self.assertEqual(len(session.calls), 3)
            self.assertEqual(len({row['externalId'] for row in entries}), len(entries))

    def test_existing_gap_is_not_cleared_by_a_successful_later_window(self):
        state = {'windowIds': [POST], 'checkedAt': CHECKED, 'gapSince': CHECKED}
        result = check(params(initialized=True, xSyncState=state), Session(lambda url: page([post()])), lambda entry: None, CONFIG)
        self.assertTrue(result['gap'])
        self.assertEqual(result['xSyncState']['gapSince'], CHECKED)
        self.assertIn('此前仍有', result['coverage'])

    def test_single_old_post_does_not_prove_coverage_and_cursor_is_only_a_parameter(self):
        cursor = 'https://evil.example/?x=1&y=2'
        def respond(url):
            return page([post()], cursor) if 'cursor=' not in url else page([post('2113542950370304373')], 'more')
        session = Session(respond)
        result = check(params(initialized=True, xSyncState={'windowIds': [POST], 'checkedAt': CHECKED}), session, lambda entry: None, CONFIG)
        self.assertTrue(result['gap'])
        self.assertEqual(parse_qs(urlsplit(session.calls[2][1]).query)['cursor'], [cursor])
        self.assertTrue(all(urlsplit(call[1]).hostname == 'api.fxtwitter.com' for call in session.calls))

    def test_empty_response_does_not_erase_existing_posts_or_claim_no_updates(self):
        with self.assertRaises(SourceFailure) as raised:
            check(params(), Session(lambda url: page([])), lambda entry: None, CONFIG)
        self.assertEqual(raised.exception.reason, FailureReason.PARSE_ERROR)
        result = check(params(), Session(lambda url: page([]), user(statuses=0)), lambda entry: None, CONFIG)
        self.assertEqual(result['xSyncState']['windowIds'], [])
        self.assertFalse(result['gap'])

    def test_oversized_page_keeps_bounded_originals_without_advancing_or_skipping_a_page(self):
        rows = [post(str(int(POST) + index)) for index in range(101)]
        session = Session(lambda url: page(rows, 'next'))
        entries = []
        result = check(params(), session, entries.append, CONFIG)
        self.assertEqual(len(entries), 100)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(result['status'], 'partial')
        self.assertNotIn('xSyncState', result)

    def test_non_json_success_response_does_not_become_an_empty_timeline(self):
        session = NetworkSession('x', CONFIG.domains, threading.Event(), lambda *args: None, client=httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, text='<html>service unavailable</html>'))), verify_dns=False)
        try:
            with self.assertRaises(SourceFailure) as raised:
                lookup({'query': 'creator_1'}, session, CONFIG)
            self.assertEqual(raised.exception.reason, FailureReason.PARSE_ERROR)
        finally:
            session.close()

    def test_partial_second_page_failure_preserves_streamed_originals_and_no_checkpoint(self):
        def respond(url):
            if 'cursor=' in url:
                raise SourceFailure(FailureReason.RATE_LIMITED, '限流', retry_after=90)
            return page([post()], 'next')
        session = Session(respond)
        entries = []
        with patch('nectisse_worker.follow.NetworkSession', return_value=session):
            result = job('follow.check', params(initialized=True, xSyncState={'windowIds': ['123', '124'], 'checkedAt': CHECKED}), threading.Event(), lambda *args: None, entries.append)
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['retryAfter'], 90)
        self.assertEqual(entries[0]['externalId'], POST)
        self.assertNotIn('xSyncState', result)
        self.assertTrue(session.closed)

    def test_plain_text_emoji_and_static_video_cover_respect_existing_contract(self):
        body = '<literal>\n' + '😀' * 2000
        row = post(text=body, media={'all': [{'type': 'video', 'url': 'https://video.twimg.com/video.mp4', 'thumbnail_url': 'https://pbs.twimg.com/ext_tw_video_thumb/frame.jpg'}]})
        entries = []
        check(params(), Session(lambda url: page([row])), entries.append, CONFIG)
        value = entries[0]
        self.assertTrue(value['summary'].startswith('<literal>\n'))
        self.assertLessEqual(len(value['summary'].encode('utf-16-le')) // 2, 3000)
        self.assertTrue(value['partial'])
        self.assertEqual(value['thumbnailUrl'], 'https://pbs.twimg.com/ext_tw_video_thumb/frame.jpg')
        row = post(media={'all': [{'type': 'photo', 'url': 'https://pbs.twimg.com.evil.example/image.jpg'}]})
        entries = []
        check(params(), Session(lambda url: page([row])), entries.append, CONFIG)
        self.assertEqual(entries[0]['thumbnailUrl'], '')

    def test_invalid_original_url_is_skipped_and_optional_fields_may_be_missing(self):
        entries = []
        rows = [post(url=f'https://x.com/other/status/{POST}'), post('2113542950370304373')]
        result = check(params(), Session(lambda url: page(rows)), entries.append, CONFIG)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual([item['externalId'] for item in entries], ['2113542950370304373'])
        self.assertNotIn('xSyncState', result)

    def test_real_network_layer_maps_errors_and_never_sends_x_credentials(self):
        for status, expected in [(404, 'not_found'), (429, 'rate_limited'), (401, 'access_denied'), (500, 'server_error')]:
            observed = []
            def respond(request):
                observed.append(request)
                return httpx.Response(status, headers={'retry-after': '120'}, json={'code': status})
            session = NetworkSession('x', CONFIG.domains, threading.Event(), lambda *args: None, client=httpx.Client(transport=httpx.MockTransport(respond)), verify_dns=False)
            try:
                with self.subTest(status=status), self.assertRaises(SourceFailure) as raised:
                    lookup({'query': 'creator_1'}, session, CONFIG)
                self.assertEqual(raised.exception.reason, expected)
                self.assertNotIn('cookie', observed[0].headers)
                self.assertNotIn('authorization', observed[0].headers)
                if status == 429:
                    self.assertEqual(raised.exception.retry_after, 120)
            finally:
                session.close()

    def test_http_success_business_error_and_bad_json_are_not_empty_success(self):
        for payload in [{'code': 404}, {'code': 429}, {'code': '200'}, {'code': 200, 'results': 'invalid', 'cursor': {}}]:
            with self.subTest(payload=payload), self.assertRaises(SourceFailure):
                check(params(), Session(lambda url: copy.deepcopy(payload)), lambda entry: None, CONFIG)


if __name__ == '__main__':
    unittest.main()
