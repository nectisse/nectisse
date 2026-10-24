"""amane 纯爬虫适配：网络全部回到 Nectisse 的逐请求许可。"""
import asyncio
import importlib
import json
import logging
from urllib.parse import urlsplit

from peach_core.catalog_rules import same_release_code
from nectisse_worker.catalog import CATALOG
from .base import FailureReason, SourceFailure, SiteConfig, SiteRecord

CLASSES = {'makers': ('official', 'OfficialCrawler'), 'prestige': ('prestige', 'PrestigeCrawler'), 'faleno': ('faleno', 'FalenoCrawler'), 'dahlia': ('dahlia', 'DahliaCrawler'), 'mgstage': ('mgstage', 'MGStageCrawler'), 'avsox': ('avsox', 'AvsoxCrawler'), 'freejavbt': ('freejavbt', 'FreejavbtCrawler'), 'airav': ('airav', 'AiravCrawler')}


class BoundedClient:
    def __init__(self, session, config):
        self.session, self.config = session, config
        self.web_client = self

    def for_source(self, source, config):
        return self

    async def get_text(self, url, *, headers=None, cookies=None, encoding='utf-8'):
        request_headers = dict(headers or {})
        if cookies:
            request_headers['Cookie'] = '; '.join(f'{key}={value}' for key, value in cookies.items())
        # 用户凭据优先于站点自带的年龄确认默认值。
        if self.session.cookie:
            request_headers.pop('Cookie', None)
        try:
            response = self.session.request('GET', url, config=self.config, headers=request_headers)
        except SourceFailure as error:
            if error.reason == FailureReason.NOT_FOUND:
                from amane.net.errors import RequestError, RequestFailure, FailureKind
                raise RequestError(url, RequestFailure(FailureKind.HTTP_STATUS, 'not_found', status=404)) from None
            raise
        return response.body.decode(encoding, 'replace')

    async def get_html(self, url, **kwargs):
        value = await self.get_text(url, **kwargs)
        from amane.net.errors import classify_block
        failure = classify_block(value)
        if failure:
            raise SourceFailure(map_reason(str(failure)), '来源要求登录、地区许可或浏览器验证；当前未取得资料')
        return value

    async def get_json(self, url, **kwargs):
        payload = json.loads(await self.get_text(url, **kwargs))
        if self.config.name == 'prestige' and urlsplit(url).path.startswith('/api/product/') and isinstance(payload, dict):
            # 上游用商品建档时间兜底 release；配信日期只能采用明确的 mgsStartAt。
            payload = {**payload, 'createdAt': None}
        return payload

    async def post_json(self, url, *, json: object, headers=None):
        import json as codec
        response = self.session.request('POST', url, config=self.config, body=codec.dumps(json).encode(), headers={'Content-Type': 'application/json', **(headers or {})})
        return codec.loads(response.body)

    async def get_rendered(self, url, **kwargs):
        raise SourceFailure(FailureReason.CHALLENGE, '此来源要求浏览器渲染；当前未接入原浏览器验证流程')


def map_reason(reason):
    return {'cloudflare_challenge': FailureReason.CHALLENGE, 'cloudflare_blocked': FailureReason.ACCESS_DENIED, 'ip_banned': FailureReason.ACCESS_DENIED, 'geo_restricted': FailureReason.REGION, 'age_verification': FailureReason.AUTH_REQUIRED, 'no_usable_metadata': FailureReason.PARSE_ERROR, 'http_error': FailureReason.NETWORK}.get(reason, FailureReason(reason) if reason in FailureReason else FailureReason.PARSE_ERROR)


class AmaneSource:
    def __init__(self, source):
        self.source = source
        row = CATALOG[source]
        self.config = SiteConfig(source, row['name'], 'amane-' + source, row['root'].rstrip('/'), tuple(row['domains']), 'amane')

    def query(self, code, *, session):
        import structlog
        from amane.crawlers.models import SearchQuery, FetchOptions
        from amane.enums import Language
        from amane.net.errors import SourceError
        # stdout 专供 NDJSON；来源日志可能含请求细节，不进入协议或普通诊断。
        structlog.configure(logger_factory=structlog.stdlib.LoggerFactory())
        logging.getLogger('amane').setLevel(logging.CRITICAL)
        module, name = CLASSES[self.source]
        crawler = getattr(importlib.import_module('amane.crawlers.sites.' + module), name)(client=BoundedClient(session, self.config), config=None)
        try:
            result = asyncio.run(crawler.fetch(SearchQuery(number=code), FetchOptions(language=Language.JP)))
        except SourceError as error:
            raise SourceFailure(map_reason(str(error.reason)), 'amane 来源未返回可用资料，请查看连接、登录或验证状态') from None
        if result is None:
            raise SourceFailure(FailureReason.NOT_FOUND, '来源未找到匹配作品')
        if not same_release_code(code, result.number):
            raise SourceFailure(FailureReason.PARSE_ERROR, '来源返回的编号与请求不一致，资料未采用')
        delivery = (result.release or '') if self.source == 'prestige' else ''
        return SiteRecord(source=self.source, provenance='amane-0.20.0', code=result.number, source_url=result.source_url or self.config.base_url, title=result.title or '', performers=tuple({'japanese_name': person.name} for person in result.actors), studio=result.studio or '', label=result.publisher or '', series=result.series or '', director='、'.join(result.directors), release_date='' if self.source == 'prestige' else result.release or '', tags=tuple(result.tags), cover_urls=tuple(dict.fromkeys([*result.thumb_urls, *result.poster_urls])), extra={'content_id': result.external_id or '', 'description': result.plot or '', 'delivery_date': delivery})
