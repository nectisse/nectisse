"""只获取已经核对作品身份的封面候选，不处理视频、附件或其他资源。"""
import hashlib
import io
import warnings
import re
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from peach_core.cover_identity import is_cross_product_cover, SMALL_MIN_WIDTH, MIN_WIDTH
from .base import FailureReason, SourceFailure
from .query import SOURCES

MAX_IMAGE_BYTES = 12 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000
PROBE_BYTES = 64 * 1024


def webp_size(body):
    """Pillow 的 WebP 插件需要完整文件；尺寸比较只读 RIFF 图像头。"""
    if body[:4] != b'RIFF' or body[8:12] != b'WEBP':
        raise ValueError('not WebP')
    offset = 12
    while offset + 8 <= len(body):
        kind = body[offset:offset + 4]
        size = int.from_bytes(body[offset + 4:offset + 8], 'little')
        start = offset + 8
        header = body[start:start + min(size, 10)]
        if kind == b'VP8X' and len(header) >= 10:
            if header[0] & 2:
                raise ValueError('animated WebP')
            return int.from_bytes(header[4:7], 'little') + 1, int.from_bytes(header[7:10], 'little') + 1
        if kind == b'VP8 ' and len(header) >= 10 and header[3:6] == b'\x9d\x01\x2a':
            return int.from_bytes(header[6:8], 'little') & 0x3fff, int.from_bytes(header[8:10], 'little') & 0x3fff
        if kind == b'VP8L' and len(header) >= 5 and header[0] == 0x2f:
            bits = int.from_bytes(header[1:5], 'little')
            if bits >> 29:
                raise ValueError('unsupported WebP version')
            return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
        offset = start + size + (size & 1)
    raise ValueError('incomplete WebP header')


def probe_cover(params: dict, session) -> dict:
    source, code, url = params.get('source'), str(params.get('code') or ''), str(params.get('url') or '')
    if source not in SOURCES or is_cross_product_cover(code, url):
        raise SourceFailure(FailureReason.PARSE_ERROR, '封面身份与作品不一致')
    response = session.request('GET', url, config=SOURCES[source]().config, headers={'Range': f'bytes=0-{PROBE_BYTES - 1}'}, limit=PROBE_BYTES, prefix=True)
    if re.search(r'now_?printing', response.url, re.I):
        raise SourceFailure(FailureReason.NOT_FOUND, '来源返回准备中占位图')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            if response.body[:4] == b'RIFF' and response.body[8:12] == b'WEBP':
                width, height = webp_size(response.body)
                format = 'WEBP'
            else:
                with Image.open(io.BytesIO(response.body)) as image:
                    width, height = image.size
                    format = image.format
            if format not in {'JPEG', 'PNG', 'WEBP'} or width < SMALL_MIN_WIDTH or height < 200 or width * height > Image.MAX_IMAGE_PIXELS:
                raise SourceFailure(FailureReason.PARSE_ERROR, '来源图片格式或尺寸不适合作为封面')
            return {'width': width, 'height': height, 'format': format}
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise SourceFailure(FailureReason.PARSE_ERROR, '封面头部未提供可用尺寸') from None


def fetch_cover(params: dict, session) -> dict:
    source = params.get("source")
    code = str(params.get("code") or "")
    url = str(params.get("url") or "")
    destination = Path(params["destination"])
    if source not in SOURCES or is_cross_product_cover(code, url):
        raise SourceFailure(FailureReason.PARSE_ERROR, "封面身份与作品不一致")
    config = SOURCES[source]().config
    response = session.request("GET", url, config=config, limit=MAX_IMAGE_BYTES)
    if re.search(r'now_?printing', response.url, re.I):
        raise SourceFailure(FailureReason.NOT_FOUND, '来源返回准备中占位图')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(response.body)) as image:
                width, height = image.size
                if params.get('expectedWidth', width) != width or params.get('expectedHeight', height) != height:
                    raise SourceFailure(FailureReason.PARSE_ERROR, '来源原图尺寸与探测结果不一致')
                format = image.format
                if format not in {"JPEG", "PNG", "WEBP"} or getattr(image, 'n_frames', 1) != 1:
                    raise SourceFailure(FailureReason.PARSE_ERROR, "来源图片不是支持的静态封面格式")
                if width < SMALL_MIN_WIDTH or height < 200:
                    raise SourceFailure(FailureReason.PARSE_ERROR, "来源图片尺寸不足，未作为封面保存")
                image.verify()
            with Image.open(io.BytesIO(response.body)) as image:
                image.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise SourceFailure(FailureReason.PARSE_ERROR, "来源封面无法完整解码，未保存到缓存") from None
    if session.cancelled.is_set():
        from .base import Cancelled
        raise Cancelled()
    digest = hashlib.sha256(response.body).hexdigest()
    destination.write_bytes(response.body)
    return {"sha256": digest, "width": width, "height": height, "format": format, "bytes": len(response.body), "quality": "standard" if width >= MIN_WIDTH else "small"}
