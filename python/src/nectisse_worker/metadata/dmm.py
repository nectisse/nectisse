"""保留 Peach 配信解析与身份核对，缺片时再查询 DVD 通贩目录。"""
import json
from peach_core.sources.dmm import DmmSource, code_parts
from peach_core.identity import identifies_code
from .base import FailureReason, Page, SourceFailure
from .dmm_dvd import dvd_cid, fetch_dvd, parse_dvd


def consistent(code: str, item: dict) -> bool:
    # 上游通用函数接受“任一身份命中”；这里防止 makerContentId 与原生 CID 互相冲突。
    return identifies_code(code, {"content_id": item.get("id")}) and (
        not item.get("makerContentId") or identifies_code(code, {"id": item["makerContentId"]}))


class VerifiedDmmSource(DmmSource):
    def fetch(self, code, *, session):
        try:
            return super().fetch(code, session=session)
        except SourceFailure as failure:
            if failure.reason != FailureReason.NOT_FOUND or not code_parts(code):
                raise
        return fetch_dvd(code, session)

    def query_content(self, code, cid, *, session):
        item = self.identified(code, cid, session=session)
        page = Page(self.content_url(cid), json.dumps(item).encode()) if item is not None else fetch_dvd(code, session, cid)
        return self.parse(page, code)

    def identified(self, code, cid, *, session):
        item = super().identified(code, cid, session=session)
        return item if item is not None and consistent(code, item) else None

    def parse(self, page, code):
        if dvd_cid(page.url):
            return parse_dvd(page, code)
        try:
            item = json.loads(page.body)
        except ValueError:
            raise SourceFailure(FailureReason.PARSE_ERROR, "DMM 返回的不是作品 JSON") from None
        if not isinstance(item, dict) or not consistent(code, item):
            raise SourceFailure(FailureReason.PARSE_ERROR, "DMM 的原生商品身份与作品编号不一致")
        return super().parse(page, code)
