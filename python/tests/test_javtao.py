import threading
import unittest
from unittest.mock import patch

from nectisse_worker import javtao, follow, magnets
from nectisse_worker.metadata.base import Cancelled, Page, SourceFailure
from nectisse_worker.metadata.query import query


def document(body):
    return '<html><head><title>JavTao</title></head><body><main>' + body + '</main></body></html>'


def card(code='TEST-001', actor='演员乙'):
    return f'<a class="card" href="https://javtao.com/{code.lower()}"><img src="/upload-img/{code.lower()}.webp"><span class="code">{code}</span><h2>{code} 作品</h2><span class="act">{actor}</span><span class="dt">2026-01-02</span></a>'


def actor_page(cards='', count=0, extra=''):
    return document(f'<div class="hero"><h1>演员甲</h1><p>共收录 {count} 部番号</p></div><section class="grid">{cards}</section>{extra}')


def work(code='TEST-001', rows=''):
    return document(f'''<div class="cov"><a href="/upload-img/cover.webp">封面</a></div><div class="info"><h1><span class="code">{code}</span> 作品标题</h1><dl class="meta">
    <div class="r"><dt>番号</dt><dd>{code}</dd></div><div class="r"><dt>发行日期</dt><dd>2026-01-02</dd></div>
    <div class="r"><dt>女优</dt><dd><a href="/actress/actor-a">演员甲</a><a href="/actress/actor-b">演员乙</a></dd></div>
    <div class="r"><dt>片商</dt><dd>片商</dd></div><div class="r"><dt>发行商</dt><dd>厂牌</dd></div><div class="r"><dt>番号系列</dt><dd>TEST</dd></div>
    <div class="r"><dt>导演</dt><dd>导演</dd></div></dl><div class="chips"><a>标签</a></div></div>
    <section id="magnets"><table class="mag-table"><tr><th>名称</th></tr>{rows}</table></section>''')


def magnet_row(code='TEST-001', info_hash='a' * 40):
    return f'<tr><td class="mn">{code} 作品</td><td class="ms">2.3 GB</td><td class="mf"></td><td class="md">2026-01-03</td><td><a class="mag" href="magnet:?xt=urn:btih:{info_hash}&amp;dn={code}">磁链</a></td></tr>'


class Session:
    def __init__(self, pages):
        self.pages = pages
        self.urls = []
        self.cancelled = threading.Event()

    def get(self, url, *, config):
        self.urls.append(url)
        return Page(url, self.pages[url].encode())


class JavTaoTests(unittest.TestCase):
    def test_only_transient_transport_retries_once_and_keeps_request_accounting(self):
        url = javtao.ROOT + '/test-001'
        session = Session({url: work()})
        session.failures = []
        original = session.get
        attempts = []
        def get(target, *, config):
            attempts.append(target)
            if len(attempts) == 1:
                failure = SourceFailure('network', '临时连接失败')
                session.failures.append(failure)
                raise failure
            return original(target, config=config)
        session.get = get
        self.assertTrue(javtao.fetch(session, url).body)
        self.assertEqual(attempts, [url, url])
        self.assertEqual(session.failures, [])
        with patch.object(session, 'get', side_effect=SourceFailure('access_denied', '拒绝访问')) as blocked:
            with self.assertRaises(SourceFailure):
                javtao.fetch(session, url)
            self.assertEqual(blocked.call_count, 1)
        with patch.object(session, 'get', side_effect=SourceFailure('timeout', '超时')) as timed_out:
            with self.assertRaises(SourceFailure):
                javtao.fetch(session, url)
            self.assertEqual(timed_out.call_count, 2)

    def test_metadata_search_verifies_code_and_preserves_roles_and_cover(self):
        search = javtao.ROOT + '/search?query=TEST-001'
        session = Session({search: document('<section class="grid">' + card('TEST-001') + card('TEST-0011') + '</section>'), javtao.ROOT + '/test-001': work()})
        records = query({'source': 'javtao', 'kind': 'code', 'code': 'TEST-001'}, session)
        self.assertEqual(session.urls, [search, javtao.ROOT + '/test-001'])
        record = records[0]
        self.assertEqual(record['parserVersion'], 'nectisse-javtao-1')
        self.assertEqual([person['role'] for person in record['people']], ['performer', 'performer', 'director'])
        self.assertEqual(record['covers'][0]['url'], javtao.ROOT + '/upload-img/cover.webp')
        self.assertEqual(record['series'], '')
        self.assertEqual(record['description'], '')
        self.assertEqual(record['tags'], ['标签'])

    def test_wrong_work_empty_html_ambiguous_identity_and_offsite_links_fail(self):
        with self.assertRaises(SourceFailure):
            javtao.parse_work(Page(javtao.ROOT + '/test-002', work('TEST-002').encode()), 'TEST-001')
        for body in ['', '<html><title>JavTao</title><main>系统繁忙</main></html>']:
            with self.assertRaises(SourceFailure):
                javtao.cards_of(javtao.soup_for(Page(javtao.ROOT, body.encode())))
        with self.assertRaises(SourceFailure):
            javtao.work_url('https://example.org/test-001')
        search = javtao.ROOT + '/search?query=TEST-001'
        body = document('<section class="grid">' + card() + card().replace('/test-001"', '/other-test-001"') + '</section>')
        with self.assertRaises(SourceFailure):
            javtao.fetch_work(Session({search: body}), 'TEST-001')

    def test_actor_name_uses_real_directory_links_and_direct_profile_has_no_avatar(self):
        directory = document('<div class="tag-cloud"><a class="ag-dedup" href="/actress/real-slug">演员甲</a><a class="ag-dedup" href="/actress/actor-b">演员乙</a><a class="ag-dedup" href="https://example.org/actress/fake">演员甲</a></div>')
        session = Session({javtao.ROOT + '/actress': directory})
        found = javtao.lookup({'query': '演员甲'}, session)
        self.assertEqual([item['ref'] for item in found], ['real-slug'])
        self.assertEqual(session.urls, [javtao.ROOT + '/actress'])
        url = javtao.ROOT + '/actress/real-slug'
        found = javtao.lookup({'query': url}, Session({url: actor_page()}))
        self.assertEqual(found[0]['avatarUrl'], '')
        for value in ['http://javtao.com/actress/a', javtao.ROOT + '/search?query=a', javtao.ROOT + '/actress/a?page=2']:
            with self.assertRaises(SourceFailure):
                javtao.actor_ref(value)

    def test_missing_directory_actor_uses_bounded_work_evidence_without_guessing_slug(self):
        directory = document('<div class="tag-cloud"><a class="ag-dedup" href="/actress/actor-b">演员乙</a></div>')
        search = javtao.ROOT + '/search?query=%E6%BC%94%E5%91%98%E7%94%B2'
        session = Session({javtao.ROOT + '/actress': directory, search: document('<section class="grid">' + card() + '</section>'), javtao.ROOT + '/test-001': work()})
        found = javtao.lookup({'query': '演员甲'}, session)
        self.assertEqual([item['ref'] for item in found], ['actor-a'])
        self.assertEqual(session.urls, [javtao.ROOT + '/actress', search, javtao.ROOT + '/test-001'])

    def test_actor_scan_keeps_unseen_after_old_entries_and_multi_actor_cards(self):
        url = javtao.actor_url('actor-a')
        session = Session({url: actor_page(card('TEST-001') + card('TEST-002', actor='另一位主演'), 2)})
        rows = []
        result = javtao.check({'ref': 'actor-a', 'initialized': True, 'seen': ['/test-001']}, session, rows.append)
        self.assertEqual([row['externalId'] for row in rows], ['/test-002'])
        self.assertEqual(rows[0]['author'], '演员甲')
        self.assertEqual(rows[0]['publishedAt'], '2026-01-02')
        self.assertEqual(rows[0]['publishedPrecision'], 'date')
        self.assertFalse(result['gap'])
        self.assertEqual(session.urls, [url])

    def test_actor_truncation_new_pagination_and_cancellation_do_not_claim_coverage(self):
        url = javtao.actor_url('actor-a')
        for body in [actor_page(card(), 99), actor_page(card(), 1, '<a rel="next" href="?page=2">下一页</a>'), actor_page(card() * 501, 1)]:
            rows = []
            result = javtao.check({'ref': 'actor-a'}, Session({url: body}), rows.append)
            self.assertTrue(result['gap'])
            self.assertEqual(len(rows), 1)
        session = Session({url: actor_page(card() + card('TEST-002'), 2)})
        rows = []
        def publish(row):
            rows.append(row)
            session.cancelled.set()
        with self.assertRaises(Cancelled):
            javtao.check({'ref': 'actor-a'}, session, publish)
        self.assertEqual(len(rows), 1)

    def test_magnets_deduplicate_hashes_and_missing_statistics_stay_null(self):
        body = work(rows=magnet_row() * 2 + magnet_row(info_hash='b' * 40))
        items = javtao.parse_magnets(Page(javtao.ROOT + '/test-001', body.encode()), 'TEST-001', 20)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['url'], javtao.ROOT + '/test-001')
        self.assertEqual(items[0]['sharedAt'], '2026-01-03')
        self.assertIsNone(items[0]['uploadedAt'])
        for field in ['seeders', 'leechers', 'completed']:
            self.assertIsNone(items[0][field])
        with self.assertRaises(SourceFailure):
            javtao.parse_magnets(Page(javtao.ROOT + '/test-001', work(rows=magnet_row('TEST-002')).encode()), 'TEST-001', 20)

    def test_follow_and_magnet_jobs_use_existing_fingerprint_transport(self):
        directory = document('<div class="tag-cloud"><a class="ag-dedup" href="/actress/actor-a">演员甲</a></div>')
        session = Session({javtao.ROOT + '/actress': directory})
        session.count = 1
        session.failures = []
        session.close = lambda: None
        with patch.object(follow, 'NetworkSession', return_value=session) as factory:
            result = follow.job('follow.lookup', {'provider': 'javtao', 'query': '演员甲'}, threading.Event(), lambda *args: None, lambda row: None)
            self.assertEqual(result['status'], 'success')
            self.assertTrue(factory.call_args.kwargs['fingerprint'])
        search = javtao.ROOT + '/search?query=TEST-001'
        session = Session({search: document('<section class="grid">' + card() + '</section>'), javtao.ROOT + '/test-001': work(rows=magnet_row())})
        session.count = 2
        session.close = lambda: None
        with patch.object(magnets, 'NetworkSession', return_value=session) as factory:
            result = magnets.job({'source': 'javtao', 'code': 'TEST-001'}, threading.Event(), lambda *args: None)
            self.assertEqual(result['status'], 'ready')
            self.assertTrue(factory.call_args.kwargs['fingerprint'])


if __name__ == '__main__':
    unittest.main()
