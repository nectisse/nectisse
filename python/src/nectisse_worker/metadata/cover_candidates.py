"""沿用 Peach jav_cover_fetch.dmm_cdn_images 的已验证 CDN 映射，不猜商品身份。"""
import re
from urllib.parse import urlsplit
from peach_core.cover_identity import is_cross_product_cover, THUMBNAIL


def cover_urls(code, urls, domains):
    from .network import allowed_url
    found = []
    for url in urls:
        if not isinstance(url, str) or len(url) > 2000:
            continue
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower()
        match = re.search(r'/(?:pics_dig/|dig/)?(?P<kind>digital/(?:video|amateur)|mono/movie)(?:/adult)?/(?P<cid>[^/]+)/', parsed.path, re.I)
        candidates = [url]
        if match and any(host == domain or host.endswith('.' + domain) for domain in ('dmm.co.jp', 'dmm.com')):
            kind, cid = match.group('kind').lower(), match.group('cid').lower()
            candidates += [f'https://awsimgsrc.dmm.com/dig/{kind}/{cid}/{cid}pl.jpg', f'https://awsimgsrc.dmm.co.jp/pics_dig/{kind}/{cid}/{cid}pl.jpg']
        for candidate in candidates:
            if candidate not in found and allowed_url(candidate, domains) and not is_cross_product_cover(code, candidate) and not THUMBNAIL.search(candidate) and not re.search(r'now_?printing', candidate, re.I):
                found.append(candidate)
    return found[:3]
