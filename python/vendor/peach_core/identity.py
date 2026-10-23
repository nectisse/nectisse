"""提取自 Peach metadata.py 的身份判定；函数与常量保持原实现。"""
import re
from urllib.parse import urlsplit
from .catalog_rules import same_release_code, code_query_variants, normalise_code_key

IDENTITY_FIELDS = ("id", "content_id", "source_url")


def _compact(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


#: URL 里可能承载番号的片段。路径段与查询值都可能是它，`combined=ene009` 这种
#: 还要按 `=` 再切一层才拿得到右边那一半。
_URL_TOKEN = re.compile(r"[A-Za-z0-9_]+(?:-[A-Za-z0-9]+)*")


def _release_writings(payload: dict) -> list[str]:
    """payload 里所有可能是番号写法的片段，逐个交给 `same_release_code` 比。"""
    values = [str(payload.get(field) or "") for field in ("id", "content_id")]
    url = urlsplit(str(payload.get("source_url") or ""))
    blob = f"{url.path.replace('/', ' ')} {url.query.replace('&', ' ')}"
    for chunk in blob.split():
        values.extend(_URL_TOKEN.findall(chunk))
        if "=" in chunk:
            values.append(chunk.split("=", 1)[-1])
    return [value for value in values if value]


def identifies_code(code: str, payload: dict) -> bool:
    """来源返回的是不是这个番号本身。

    2026-09-01 实测：dl.getchu 对 `ABW-220` 和 `259LUXU-1475` 都返回同一件同人
    商品 `item33938`（`Gカップ黒髪ぱっつん美少女レイヤー05華仙`）。适配器取的是
    站内搜索首条命中，站里没有这个番号时它不报「查无此片」，而是把不相干的商品
    当结果交出来。没有这道闸，那件商品的 genre 会变成三个番号的官方标签。

    真实来源的写法要容得下：DMM 的 `118abw220` 带厂牌数字前缀，r18dev 的
    `h_086iqqq00026` 对 `IQQQ-026` 多补了零，`259LUXU-1475` 只在 URL 里出现。
    实测 800 条成功快照里，除 dl.getchu 的 3 条错配外全部命中。

    先问 `same_release_code`，它认得 FC2 的裸数字写法和登记过的前缀别名；下面那套
    正则不认，于是把 `FC2-PPV-3701252` 和来源返回的 `3701252` 判成两部作品。2026-09-09
    实测候选池里 450 条 fc2 候选全部因此被误判为错配，占当时判否总数的一半以上。
    两条判据取并集：`same_release_code` 严格但不认厂牌数字前缀（`MAAN-545` 与
    `300MAAN-545`），正则宽松但认得，去掉任何一条都有 16 条合法候选被误拒。
    """
    if any(same_release_code(code, writing) for writing in _release_writings(payload)):
        return True
    if re.match(r"^\d{3}[A-Z]", str(code or "").upper()):
        url = urlsplit(str(payload.get("source_url") or ""))
        product = re.fullmatch(r"/product/product_detail/([^/]+)/?", url.path)
        returned = str(payload.get("id") or payload.get("content_id") or "")
        if url.hostname in {"mgstage.com", "www.mgstage.com"} and product:
            product_code = product.group(1)
            return same_release_code(code, product_code) and (
                not returned or same_release_code(product_code, returned)
                or normalise_code_key(returned) in code_query_variants(product_code))
        return any(same_release_code(code, payload.get(field)) for field in ("id", "content_id"))
    blob = "|".join(_compact(payload.get(field)) for field in IDENTITY_FIELDS)
    if not blob.strip("|"):
        return False
    value = str(code or "").upper()
    matched = re.fullmatch(r"(?:\d{3,6})?([A-Z]{2,8})-?(\d{2,5})", value)
    if matched:
        letters, digits = matched.group(1).lower(), matched.group(2).lstrip("0") or "0"
        return any(re.search(rf"(?<![a-z]){letters}[-_]?0*{digits}(?!\d)",
                             str(payload.get(field) or "").lower()) is not None
                   for field in IDENTITY_FIELDS)
    return _compact(value) in blob
