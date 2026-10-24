"""Sukebei 表格与编号边界；仅使用无资源的本地样例。"""
import html
import threading
import unittest
from unittest.mock import patch

from nectisse_worker.magnets import job, parse_search
from nectisse_worker.metadata.base import Cancelled, Page, SourceFailure


def row(index=1, title='TIKB-220 示例记录', magnet=True, timestamp='1777609767'):
    uri = f'magnet:?xt=urn:btih:{index:040x}&amp;dn=example'
    return f'''<tr><td>分类</td><td colspan="2"><a class="comments" href="/view/{index}#comments">1</a>
    <a href="/view/{index}">{html.escape(title)}</a></td><td>{f'<a href="{uri}">链接</a>' if magnet else ''}</td>
    <td>3.0 GiB</td><td data-timestamp="{timestamp}">2026-05-01</td><td>0</td><td>2</td><td>1,234</td></tr>'''


def table(*rows):
    return '<table class="torrent-list"><tbody>' + ''.join(rows) + '</tbody></table>'


class MagnetTests(unittest.TestCase):
    def test_columns_comment_link_zero_and_utc(self):
        item = parse_search(table(row()), 'TIKB-220')[0]
        self.assertEqual(item['title'], 'TIKB-220 示例记录')
        self.assertEqual(item['url'], 'https://sukebei.nyaa.si/view/1')
        self.assertEqual(item['size'], '3.0 GiB')
        self.assertEqual(item['seeders'], 0)
        self.assertEqual(item['leechers'], 2)
        self.assertEqual(item['completed'], 1234)
        self.assertEqual(item['uploadedAt'], '2026-05-01T04:29:27Z')
        self.assertIn('&dn=example', item['magnet'])

    def test_exact_number_boundary_variants_and_dedup(self):
        body = table(row(1, '[FHD] TIKB220 示例'), row(2, 'TIKB-2200 示例'), row(3, 'ATIKB-220 示例'), row(4, 'TIKB-0220 示例'), row(1))
        self.assertEqual([item['id'] for item in parse_search(body, 'TIKB-220')], [f'{1:040x}', f'{4:040x}'])
        dated = table(row(1, '092415_001 示例'), row(2, '092415-001 示例'))
        self.assertEqual(len(parse_search(dated, '092415_001')), 1)
        self.assertEqual(len(parse_search(table(row(1, 'FC2 PPV 1234567 示例')), 'FC2-PPV-1234567')), 1)

    def test_twenty_results_in_source_order_without_details(self):
        values = parse_search(table(*(row(i) for i in range(1, 76))), 'TIKB-220')
        self.assertEqual(len(values), 20)
        self.assertEqual(values[-1]['id'], f'{20:040x}')

    def test_configured_result_limit_and_transport_reach_session(self):
        body = table(*(row(i) for i in range(1, 31)))
        for limit in (5, 10, 20):
            self.assertEqual(len(parse_search(body, 'TIKB-220', limit)), limit)
        with patch('nectisse_worker.magnets.NetworkSession') as factory:
            factory.return_value.get.return_value = Page('https://sukebei.nyaa.si/', body.encode())
            factory.return_value.count = 1
            result = job({'code': 'TIKB-220', 'maxResults': 5, 'transport': 'fingerprint'}, threading.Event(), lambda *args: None)
            self.assertEqual(len(result['items']), 5)
            self.assertTrue(factory.call_args.kwargs['fingerprint'])
        for limit in (0, 21, True):
            with self.assertRaises(ValueError):
                job({'code': 'TIKB-220', 'maxResults': limit}, threading.Event(), lambda *args: None)

    def test_empty_changed_page_invalid_hash_and_no_date(self):
        self.assertEqual(parse_search(table(), 'TIKB-220'), [])
        self.assertEqual(parse_search('<h3>No results found</h3><div class="pagination-page-info">Displaying results 0-0 out of 0 results.</div>', 'TIKB-220'), [])
        self.assertEqual(parse_search(table(row(1, 'TIKB-221 示例')), 'TIKB-220'), [])
        with self.assertRaises(SourceFailure):
            parse_search('<html>请验证</html>', 'TIKB-220')
        with self.assertRaises(SourceFailure):
            parse_search(table(row(magnet=False)), 'TIKB-220')
        with self.assertRaises(SourceFailure):
            parse_search(table(row().replace('urn:btih:', 'urn:invalid:')), 'TIKB-220')
        self.assertIsNone(parse_search(table(row(timestamp='unknown')), 'TIKB-220')[0]['uploadedAt'])

    def test_job_single_search_request_proxy_and_cancel(self):
        urls = []
        class Session:
            count = 1
            def __init__(self, *args, **kwargs):
                self.proxy = kwargs['proxy']
            def get(self, url, **kwargs):
                urls.append(url)
                return Page(url, table(row()).encode())
            def close(self):
                pass
        with patch('nectisse_worker.magnets.NetworkSession', Session):
            result = job({'code': 'TIKB-220', 'proxy': 'http://127.0.0.1:7890'}, threading.Event(), lambda *args: None)
            self.assertEqual(result['status'], 'ready')
            self.assertEqual(urls, ['https://sukebei.nyaa.si/?f=0&c=0_0&q=TIKB-220'])
            cancelled = threading.Event()
            cancelled.set()
            with self.assertRaises(Cancelled):
                job({'code': 'TIKB-220'}, cancelled, lambda *args: None)


if __name__ == '__main__':
    unittest.main()
