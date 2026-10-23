"""保留 Peach DMM 解析器，并在商品身份冲突时收紧接收条件。"""
import json
from peach_core.sources.dmm import DmmSource
from peach_core.identity import identifies_code
from .base import FailureReason, SourceFailure


def consistent(code: str, item: dict) -> bool:
    # 上游通用函数接受“任一身份命中”；这里防止 makerContentId 与原生 CID 互相冲突。
    return identifies_code(code, {"content_id": item.get("id")}) and (
        not item.get("makerContentId") or identifies_code(code, {"id": item["makerContentId"]}))


class VerifiedDmmSource(DmmSource):
    def identified(self, code, cid, *, session):
        item = super().identified(code, cid, session=session)
        return item if item is not None and consistent(code, item) else None

    def parse(self, page, code):
        try:
            item = json.loads(page.body)
        except ValueError:
            raise SourceFailure(FailureReason.PARSE_ERROR, "DMM 返回的不是作品 JSON") from None
        if not isinstance(item, dict) or not consistent(code, item):
            raise SourceFailure(FailureReason.PARSE_ERROR, "DMM 的原生商品身份与作品编号不一致")
        return super().parse(page, code)
