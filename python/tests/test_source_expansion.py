import hashlib
import importlib
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from peach_core.http import HttpResponse
from nectisse_worker.catalog import CATALOG
from nectisse_worker.follow import lookup, check
from nectisse_worker.follow_extended import identity, canonical
from nectisse_worker.metadata.base import Page, SourceFailure
from nectisse_worker.metadata.network import NetworkSession
from nectisse_worker.metadata.query import SOURCES, normalize, query
from nectisse_worker.metadata.amane import AmaneSource, CLASSES


class Session:
    cookie = ''
    def __init__(self, responder):
        self.responder = responder
        self.calls = []
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        data = self.responder(url)
        return HttpResponse(200, {}, data if isinstance(data, bytes) else data.encode() if isinstance(data, str) else json.dumps(data).encode(), url)
    def get(self, url, **kwargs):
        response = self.request('GET', url, **kwargs)
        return Page(response.url, response.body)


class ExpansionTests(unittest.TestCase):
    def test_removed_sources_cannot_dispatch_or_make_requests(self):
        session = Session(lambda url: self.fail('已移除来源不应发起网络请求'))
        for source in ['rule34video', 'subscribestar', 'rule34xxx', 'rule34paheal', 'fc2club', 'kmib']:
            self.assertNotIn(source, CATALOG)
            self.assertNotIn(source, SOURCES)
        for source in ['fc2club', 'kmib']:
            with self.assertRaises(SourceFailure) as raised:
                query({'source': source, 'kind': 'code', 'code': 'ABC-001'}, session)
            self.assertEqual(raised.exception.reason, 'unsupported')
        for provider in ['rule34video', 'subscribestar']:
            with self.assertRaises(SourceFailure) as raised:
                lookup({'provider': provider, 'query': 'creator'}, session)
            self.assertEqual(raised.exception.reason, 'unsupported')
            with self.assertRaises(SourceFailure) as raised:
                check({'provider': provider, 'ref': 'creator'}, session, lambda entry: None)
            self.assertEqual(raised.exception.reason, 'unsupported')
        self.assertEqual(session.calls, [])

    def test_all_declared_metadata_adapters_load_without_peach_or_database(self):
        self.assertEqual(set(SOURCES), {key for key, row in CATALOG.items() if row['metadata']})
        for key, factory in SOURCES.items():
            self.assertEqual(factory().config.name, key)
        for key, (module, name) in CLASSES.items():
            cls = getattr(importlib.import_module('amane.crawlers.sites.' + module), name)
            self.assertEqual(str(cls.profile().name), 'official' if key == 'makers' else key)
        self.assertNotIn('sqlalchemy', sys.modules)
        self.assertNotIn('peach.library_processing', sys.modules)

    def test_amane_snapshot_files_and_manufacturer_domains_match(self):
        vendor = Path(__file__).parents[1] / 'vendor'
        manifest = json.loads((vendor / 'amane-extraction.json').read_text())
        for row in manifest['records']:
            self.assertEqual(hashlib.sha256((vendor / 'amane' / row['path']).read_bytes()).hexdigest(), row['upstreamSha256'])
        from amane.crawlers.sites.official import MANUFACTURER_DOMAINS
        self.assertEqual({value.removeprefix('www.') for value in MANUFACTURER_DOMAINS.values()}, set(CATALOG['makers']['domains']))

    def test_prestige_uses_bounded_network_and_separate_delivery_date(self):
        def respond(url):
            return {'parentProduct': {'uuid': 'native-product'}} if '/sku/' in url else {'uuid': 'native-product', 'sku': [{'deliveryItemId': 'ABW-350'}], 'title': '公式作品', 'mgsStartAt': '2026-10-01T00:00:00Z', 'actress': [{'name': '架空作者'}], 'thumbnail': {'path': 'front.jpg'}, 'packageImage': {'path': 'spread.jpg'}}
        session = Session(respond)
        record = normalize(AmaneSource('prestige').query('ABW-350', session=session))
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(record['releaseDate'], '')
        self.assertEqual(record['deliveryDate'], '2026-10-01')
        self.assertEqual(record['code'], 'ABW-350')
        self.assertEqual(len(record['covers']), 2)
        with self.assertRaises(SourceFailure):
            AmaneSource('prestige').query('ABW-351', session=session)

    def test_wordpress_faleno_and_dahlia_preserve_site_identity(self):
        for key, code in [('faleno', 'FNS-257'), ('dahlia', 'DLDSS-001')]:
            data = [{'slug': code.replace('-', '').lower(), 'title': {'rendered': '公式作品'}, 'acf': {'作品名': '公式作品', '出演女優': '架空花子', '発売日（表示用）': '2026-10-01'}, 'acf_custom_images': {'main_photo_url': CATALOG[key]['root'] + 'main.jpg'}}]
            record = AmaneSource(key).query(code, session=Session(lambda url: data))
            self.assertEqual(record.source, key)
            self.assertEqual(record.code, code)
            self.assertEqual(record.performers[0]['japanese_name'], '架空花子')

    def test_prestige_creation_time_is_not_delivery_date(self):
        def respond(url):
            if '/sku/' in url:
                return {'parentProduct': {'uuid': 'native-product'}}
            return {'uuid': 'native-product', 'sku': [{'deliveryItemId': 'ABW-350'}],
                    'title': '公式作品', 'createdAt': '2020-01-02T03:04:05Z'}
        session = Session(respond)
        record = normalize(AmaneSource('prestige').query('ABW-350', session=session))
        self.assertEqual(record['deliveryDate'], '')
        self.assertEqual(record['releaseDate'], '')
        self.assertEqual(len(session.calls), 2)

    def test_amane_compact_numbers_group_with_other_metadata_sources(self):
        from nectisse_worker.metadata.base import SiteRecord
        result = normalize(SiteRecord('makers', 'amane-0.20.0', 'SSIS057', 'https://s1s1s1.com/works/detail/SSIS057', title='公式作品'))
        self.assertEqual(result['code'], 'SSIS-057')

    def test_onepondo_exact_movie_identity_and_javdb_images_not_promoted_to_cover(self):
        adapter = SOURCES['1pondo']()
        page = Page('https://www.1pondo.tv/data.json', json.dumps({'MovieID': '092415_001', 'Title': '公式作品', 'ActressesJa': ['架空花子'], 'Release': '2015-09-24', 'ThumbHigh': 'https://www.1pondo.tv/a.jpg'}).encode())
        result = normalize(adapter.parse(page, '092415_001'))
        self.assertEqual(result['releaseDate'], '2015-09-24')
        with self.assertRaises(SourceFailure):
            adapter.parse(page, '092415_002')
        html = '<div class="panel-block"><strong>番號:</strong><span class="value">ABW-220</span></div><strong class="current-title">資料</strong><img class="video-cover" src="https://c0.jdbstatic.com/a.jpg">'
        record = SOURCES['javdb']().parse(Page('https://javdb.com/v/test', html.encode()), 'ABW-220')
        self.assertEqual(normalize(record)['covers'], [])

    def test_wiki_names_reuse_work_evidence_and_preserve_review_warning(self):
        root = 'https://seesaawiki.jp/av_name/'
        html = f'<div id="page-body"><div class="user-area"><table><tr><th>品番</th><td>ABC-001</td></tr><tr><th>出演女優</th><td><a href="{root}d/A">架空花子</a></td></tr></table></div></div>'
        rows = SOURCES['av_name']().rows(Page(root + 'd/ABC%2d001', html.encode('euc_jp')))
        self.assertEqual(len(rows), 1)
        result = normalize(rows[0])
        self.assertEqual(result['people'][0]['name'], '架空花子')
        self.assertTrue(result['warnings'])

    def test_patreon_public_card_time_is_marked_approximate(self):
        html = '<html><h1>公開作者</h1><article><h3>进度公告</h3><p>1 day ago</p><a href="/posts/announcement-12345">原文</a></article></html>'
        candidate = lookup({'provider': 'patreon', 'query': 'creator'}, Session(lambda url: html))[0]
        self.assertEqual(candidate['url'], 'https://www.patreon.com/cw/creator')
        entries = []
        check({'provider': 'patreon', 'ref': 'creator', 'initialized': True, 'seen': []}, Session(lambda url: html), entries.append)
        self.assertEqual(entries[0]['publishedPrecision'], 'approximate')
        self.assertEqual(len(entries), 1)

    def test_official_unrecognized_page_is_not_a_successful_empty_check(self):
        html = '<html><h1>Creator</h1><div>Temporarily unavailable</div></html>'
        for provider, ref in [('patreon', 'creator')]:
            with self.subTest(provider=provider, operation='lookup'), self.assertRaises(SourceFailure) as raised:
                lookup({'provider': provider, 'query': ref}, Session(lambda url: html))
            self.assertEqual(raised.exception.reason, 'parse_error')
            for initialized in [False, True]:
                entries = []
                with self.subTest(provider=provider, initialized=initialized), self.assertRaises(SourceFailure) as raised:
                    check({'provider': provider, 'ref': ref, 'initialized': initialized}, Session(lambda url: html), entries.append)
                self.assertEqual(raised.exception.reason, 'parse_error')
                self.assertEqual(entries, [])

    def test_archives_keep_text_announcements_bound_pagination_and_reject_other_user(self):
        for provider in ['kemono', 'pawchive', 'coomer']:
            posts = [{'id': str(i), 'service': 'fanbox', 'user': '12345', 'title': '文字进度', 'content': '没有资源附件的公告', 'published': '2026-10-01T12:00:00Z'} for i in range(50)]
            session = Session(lambda url: {'posts': posts} if provider == 'kemono' else posts)
            entries = []
            result = check({'provider': provider, 'ref': 'fanbox/12345', 'initialized': True, 'seen': []}, session, entries.append)
            self.assertEqual(len(session.calls), 2)
            self.assertTrue(result['gap'])
            self.assertEqual(entries[0]['summary'], '没有资源附件的公告')
            self.assertEqual(session.calls[0][2]['headers']['Accept'], 'text/css')
            self.assertEqual(entries[0]['url'], canonical(provider, 'fanbox/12345') + '/post/0')
        with self.assertRaises(SourceFailure):
            check({'provider': 'kemono', 'ref': 'fanbox/12345'}, Session(lambda url: [{'id': '1', 'user': '999', 'service': 'fanbox'}]), lambda entry: None)

    def test_extended_profile_identity_rejects_posts_reserved_pages_and_private_hosts(self):
        for provider, value in [('patreon', 'https://www.patreon.com/login'), ('patreon', 'https://evil.example/cw/creator'), ('kemono', 'https://kemono.cr/fanbox/user/123/post/1'), ('coomer', 'service/..')]:
            with self.assertRaises(SourceFailure, msg=(provider, value)):
                identity(provider, value)

    def test_metadata_cookie_is_source_bound_and_redirect_guard_still_applies(self):
        observed = []
        def respond(request):
            observed.append(dict(request.headers))
            return httpx.Response(200, content=b'ok')
        session = NetworkSession('avbase', ('avbase.net', 'dmm.com'), threading.Event(), lambda *args: None, client=httpx.Client(transport=httpx.MockTransport(respond)), verify_dns=False, cookie='private=session')
        try:
            config = SOURCES['avbase']().config
            session.get('https://www.avbase.net/works', config=config)
            session.request('GET', 'https://pics.dmm.com/a.jpg', config=config)
            self.assertEqual(observed[0].get('cookie'), 'private=session')
            self.assertNotIn('cookie', observed[1])
        finally:
            session.close()


if __name__ == '__main__':
    unittest.main()
