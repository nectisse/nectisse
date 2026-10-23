"""官方公开卡片连接器的有界传输契约。"""
from dataclasses import dataclass
from bs4 import BeautifulSoup
from .metadata.base import FailureReason, SourceFailure


def plain_text(value):
    return BeautifulSoup(str(value or ''), 'html.parser').get_text(' ', strip=True)


class FollowSourceError(SourceFailure):
    def __init__(self, message):
        super().__init__(FailureReason.PARSE_ERROR, message)


@dataclass
class ParsedSource:
    provider: str
    ref: str
    url: str
    label: str


class _BaseConnector:
    def __init__(self, session, config, params):
        self.session, self.config, self.params = session, config, params
        self.max_items = 20

    def _request(self, url, *, ref, etag=None, last_modified=None, headers=None):
        from .follow import headers as source_headers
        response = self.session.request('GET', url, config=self.config, headers={**source_headers(self.provider, self.params.get('cookie', '')), **(headers or {})}, fingerprint=self.params.get('transport') == 'fingerprint')
        return {'provider': self.provider, 'ref': ref, 'request_url': response.url, 'semantics': 'work'}, response
