"""提取自 Peach jav_cover_fetch.py 的跨作品封面判定。"""
import re
from urllib.parse import urlparse
from .catalog_rules import normalise_code_key, code_letter_stem

MIN_WIDTH = 700
SMALL_MIN_WIDTH = 240
THUMBNAIL = re.compile(r"(thumb|small|icon|/ts/|-s\d|_s\.)", re.I)

_DMM_CID = re.compile(
    r"/(?:pics_dig/|dig/)?(?:digital/(?:video|amateur)|mono/movie)"
    r"(?:/adult)?/(?P<cid>[^/]+)/",
    re.I,
)
#: 番号与 content_id 各自末尾那段数字。content_id 可能带 DVD 版尾缀（`49ha102r`）。
_CODE_NUMBER = re.compile(r"(\d+)\D*$")
_CID_NUMBER = re.compile(r"(\d+)[a-z]*$")
#: 图床文件名里的作品号：五到七位的独立数字段。`pl1654160016.07k.gif` 那种十位的是
#: 上传时间戳，不算作品号。
_FILE_NUMBER = re.compile(r"(?<!\d)\d{5,7}(?!\d)")
#: 图床给上传起的十六进制串（PHP `uniqid`，13 位）。`5dd29b14380eaPS.jpg` 里夹着的
#: `14380` 是串的一截，不是作品号。
_UPLOAD_HASH = re.compile(r"[0-9a-f]{13,}", re.I)


def _fc2_names_another_work(code: str, url: str) -> bool:
    """FC2 番号的图，文件名写着别的作品号。

    JavArchive 的图床 img.javstore.net 按作品号起文件名（`FC2PPV-2543627.gif`、
    `1083921pl.jpg`）。
    """
    key = normalise_code_key(code)
    wanted = _CODE_NUMBER.search(key) if key.startswith("FC2") else None
    name = _UPLOAD_HASH.sub("", urlparse(url or "").path.rsplit("/", 1)[-1])
    numbers = {int(one) for one in _FILE_NUMBER.findall(name)}
    return bool(wanted and numbers) and int(wanted.group(1)) not in numbers


def is_cross_product_cover(code: str, url: str) -> bool:
    """这个 URL 指向的是另一部片的封套。

    素人系番号在 avbase 上会连到 DVD 合集：`259LUXU-1475` 的页面主图取到的是
    `SNG-021` 的封套（`118sng021`）。内容是同一段，封面却不是这部片的——大图
    模式的人脸定位、番号搜索和「这张图是谁」全都跟着错位。

    avbase 抓取已在 65fd95f 删掉，这批 URL 却靠「复用上一轮成功记录」一路带到
    今天：复用只看 result 是不是「取得」，不看它和番号是否对得上，于是错误封面
    再也没有机会被重探。判据落在 URL 上而不是抓取路径上，正是因为下一个引入
    错图的来源不会用同一个函数。
    """
    if _fc2_names_another_work(code, url):
        return True
    stem = code_letter_stem(code)
    match = _DMM_CID.search(urlparse(url or "").path)
    if not stem or match is None:
        return False
    cid = match.group("cid").lower()
    if stem not in cid:
        return True
    # 字母段对上还不够：`YUJ-101` 取回的是 `yuj00011`，`CHU-201` 是 `chu00021`，
    # `435MFC-135` 是 `h_1711mfcc00027`。数字段按整数比，补零和厂牌前缀都不影响。
    wanted, got = _CODE_NUMBER.search(code or ""), _CID_NUMBER.search(cid)
    return bool(wanted and got) and int(wanted.group(1)) != int(got.group(1))
