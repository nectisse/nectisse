"""FxEmbed 公开账号适配；仅收录本人原创，旧帖图片详情按需补取。"""
import json
import math
import re
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit

from .catalog import CATALOG, image_domains
from .metadata.base import FailureReason, SourceFailure
from .metadata.network import allowed_url

HANDLE = re.compile(r'^[A-Za-z0-9_]{1,15}$')
NATIVE_ID = re.compile(r'^[1-9]\d{0,24}$')
RESERVED = {'i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'login', 'signup', 'compose', 'intent', 'tos', 'privacy', 'share', 'hashtag', 'lists'}
INPUT_HOSTS = {'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'}
MAX_PAGE_ITEMS = 100


def text(value, limit):
    value = value if isinstance(value, str) else ''
    return value.replace('\r\n', '\n').replace('\r', '\n').strip().encode('utf-16-le', 'replace')[:limit * 2].decode('utf-16-le', 'ignore')


def identity(value):
    value = str(value or '').strip()
    if '://' in value:
        parsed = urlsplit(value)
        if not allowed_url(value, ('x.com', 'twitter.com')) or parsed.hostname not in INPUT_HOSTS:
            raise SourceFailure(FailureReason.UNSUPPORTED, '请输入 X 或 Twitter 的 HTTPS 账号主页')
        match = re.fullmatch(r'/([A-Za-z0-9_]{1,15})/?', parsed.path)
        value = match[1] if match else ''
    else:
        value = value.removeprefix('@')
    if not HANDLE.fullmatch(value) or value.lower() in RESERVED:
        raise SourceFailure(FailureReason.UNSUPPORTED, '请输入 X 账号名、@账号或主页链接，不是帖子或搜索页')
    return value.lower()


def request_json(session, config, path, params):
    url = CATALOG['x']['apiRoot'] + path
    if params:
        url += '?' + urlencode(params)
    try:
        response = session.request('GET', url, config=config, headers={'Accept': 'application/json'})
    except SourceFailure as error:
        if error.reason == FailureReason.NOT_FOUND:
            raise SourceFailure(error.reason, 'FxEmbed 暂时无法取得此账号；账号可能不存在或上游不可用') from None
        if error.reason == FailureReason.AUTH_REQUIRED:
            raise SourceFailure(FailureReason.ACCESS_DENIED, 'FxEmbed 暂时无法读取公开账号，请稍后重试') from None
        raise
    try:
        payload = json.loads(response.body)
    except (ValueError, UnicodeError):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 未返回可识别的账号数据') from None
    if not isinstance(payload, dict):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 响应结构不正确')
    code = payload.get('code')
    if type(code) is not int or code != 200:
        reason = {400: FailureReason.UNSUPPORTED, 401: FailureReason.ACCESS_DENIED, 403: FailureReason.ACCESS_DENIED, 404: FailureReason.NOT_FOUND, 429: FailureReason.RATE_LIMITED, 500: FailureReason.SERVER_ERROR}.get(code, FailureReason.PARSE_ERROR) if type(code) is int else FailureReason.PARSE_ERROR
        raise SourceFailure(reason, 'FxEmbed 本次未能取得公开资料，请检查账号或稍后重试', retry_after=60 if reason == FailureReason.RATE_LIMITED else 0)
    return payload


def profile(session, config, account, expected_ref=None):
    payload = request_json(session, config, '/2/profile/' + account, {})
    user = payload.get('user')
    if not isinstance(user, dict):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 未返回可核对的账号资料')
    ref, handle = user.get('id'), user.get('screen_name')
    if not isinstance(ref, str) or not NATIVE_ID.fullmatch(ref) or not isinstance(handle, str) or not HANDLE.fullmatch(handle) or handle.lower() in RESERVED:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'X 账号缺少有效的数字身份或账号名')
    if expected_ref is not None and ref != expected_ref:
        raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 返回的账号与关注身份不一致')
    if expected_ref is None and handle.lower() != account.lower():
        raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 返回了另一账号的资料')
    if user.get('protected') is True:
        raise SourceFailure(FailureReason.ACCESS_DENIED, '此 X 账号已保护，仅支持读取公开账号的原创帖')
    if user.get('protected') is not False:
        raise SourceFailure(FailureReason.PARSE_ERROR, '尚未确认此 X 账号是否公开')
    avatar = user.get('avatar_url') or ''
    if isinstance(avatar, str) and allowed_url(avatar, image_domains('x')):
        parsed = urlsplit(avatar)
        if parsed.hostname == 'pbs.twimg.com' and parsed.path.startswith('/profile_images/'):
            # FxEmbed 资料接口仍可能给 48px 头像，使用其帖子转换器同样的 200px 版本。
            avatar = parsed._replace(path=re.sub(r'_normal(?=\.(?:jpe?g|png|webp)$)', '_200x200', parsed.path, flags=re.I)).geturl()
    candidate = {'provider': 'x', 'ref': ref, 'handle': handle, 'name': text(user.get('name'), 200) or handle, 'url': f'https://x.com/{handle}', 'aliases': [], 'recordType': '公开账号 · 本人原创', 'bio': text(user.get('description'), 1000), 'evidence': 'FxEmbed 返回的 X 数字用户身份；仅收录本人原创帖', 'avatarUrl': avatar if isinstance(avatar, str) and len(avatar) <= 2000 and allowed_url(avatar, image_domains('x')) else ''}
    count = user.get('statuses')
    return candidate, count if type(count) is int and count >= 0 else None


def lookup(params, session, config):
    candidate, _ = profile(session, config, identity(params.get('query')))
    return [candidate]


def images(row):
    media = row.get('media')
    if not isinstance(media, dict):
        return []
    items = media.get('all')
    if not isinstance(items, list) or not items:
        photos, videos = media.get('photos'), media.get('videos')
        items = [{**item, 'type': item.get('type', 'photo')} for item in (photos if isinstance(photos, list) else []) if isinstance(item, dict)]
        items += videos if isinstance(videos, list) else []
    result, seen = [], set()
    for item in items[:20]:
        if not isinstance(item, dict):
            continue
        url = item.get('url') if item.get('type') == 'photo' else item.get('thumbnail_url') if item.get('type') in {'video', 'gif'} else None
        if isinstance(url, str) and len(url) <= 2000 and allowed_url(url, image_domains('x')):
            if url in seen:
                continue
            seen.add(url)
            picture = {'url': url}
            for name in ('width', 'height'):
                value = item.get(name)
                if type(value) is int and 0 < value <= 40000:
                    picture[name] = value
            alt = text(item.get('altText'), 1000)
            if alt:
                picture['alt'] = alt
            result.append(picture)
    return result


def original(row, ref):
    author = row.get('author')
    return isinstance(author, dict) and author.get('id') == ref and all(row.get(key) is None for key in ('replying_to', 'reposted_by', 'quote'))


def entry(row, ref):
    key = row.get('id')
    author = row.get('author') or {}
    handle = author.get('screen_name')
    if not isinstance(key, str) or not NATIVE_ID.fullmatch(key) or not isinstance(handle, str) or not HANDLE.fullmatch(handle):
        raise ValueError('Invalid post identity')
    url = row.get('url')
    if not isinstance(url, str) or not allowed_url(url, ('x.com', 'twitter.com')):
        raise ValueError('Invalid post URL')
    parsed = urlsplit(url)
    if parsed.hostname not in {'x.com', 'twitter.com'} or parsed.path.lower() != f'/{handle}/status/{key}'.lower() or parsed.query or parsed.fragment:
        raise ValueError('Post URL identity mismatch')
    stamp = row.get('created_timestamp')
    if type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp <= 0:
        raise ValueError('Invalid post time')
    published = datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace('+00:00', 'Z')
    body = row.get('text')
    if not isinstance(body, str):
        raise ValueError('Missing post text')
    body = body.replace('\r\n', '\n').replace('\r', '\n').strip()
    summary = text(body, 3000)
    clipped = len(body.encode('utf-16-le', 'replace')) > 6000
    lines = body.splitlines()
    title = text(lines[0] if lines else '', 120) or '原创媒体动态'
    pictures = images(row)
    return {'externalId': key, 'title': title, 'summary': summary, 'author': text(author.get('name'), 200) or handle, 'authorRef': ref, 'authorHandle': handle, 'postKind': 'original', 'publishedAt': published, 'publishedPrecision': 'exact', 'url': f'https://x.com/{handle}/status/{key}', 'thumbnailUrl': pictures[0]['url'] if pictures else '', 'images': pictures, 'code': '', 'restricted': False, 'partial': clipped}


def details(params, session, config):
    ref, key = params.get('ref'), params.get('externalId')
    if not isinstance(ref, str) or not NATIVE_ID.fullmatch(ref) or not isinstance(key, str) or not NATIVE_ID.fullmatch(key):
        raise SourceFailure(FailureReason.UNSUPPORTED, '帖子身份不正确')
    payload = request_json(session, config, '/2/status/' + key, {})
    row = payload.get('status')
    if not isinstance(row, dict) or row.get('id') != key or not original(row, ref) or not isinstance(row.get('media'), dict):
        raise SourceFailure(FailureReason.PARSE_ERROR, '原帖身份或原创状态不匹配，已保留原有内容')
    return entry(row, ref)


def check(params, session, publish, config):
    ref = params.get('ref')
    if not isinstance(ref, str) or not NATIVE_ID.fullmatch(ref):
        raise SourceFailure(FailureReason.UNSUPPORTED, 'X 订阅需要已核对的数字用户身份')
    candidate, post_count = profile(session, config, 'id:' + ref, ref)
    previous = params.get('xSyncState')
    previous = previous if isinstance(previous, dict) else {}
    old_window = previous.get('windowIds', [])
    if not isinstance(old_window, list) or len(old_window) > MAX_PAGE_ITEMS or any(not isinstance(key, str) or not NATIVE_ID.fullmatch(key) for key in old_window):
        raise SourceFailure(FailureReason.PARSE_ERROR, 'X 检查窗口格式不正确，已有动态已保留')
    first = not params.get('initialized') or not previous
    pages, emitted, observed, window = set(), set(), set(), []
    cursors, cursor, ended = set(), '', False
    warnings = []
    count = 0
    for page in range(1 if first else 2):
        query = {'count': 20, **({'cursor': cursor} if cursor else {})}
        payload = request_json(session, config, f'/2/profile/id:{ref}/statuses', query)
        rows, pagination = payload.get('results'), payload.get('cursor')
        if not isinstance(rows, list) or not isinstance(pagination, dict):
            raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 时间线结构不正确')
        truncated = len(rows) > MAX_PAGE_ITEMS
        if truncated:
            rows = rows[:MAX_PAGE_ITEMS]
            warnings.append('来源返回条数超出本次范围，已保留可检查的原创帖')
        if not rows and post_count != 0:
            raise SourceFailure(FailureReason.PARSE_ERROR, 'FxEmbed 未返回可核对的帖子列表，暂不能确认是否没有更新')
        signature = tuple((str(row.get('type')), row.get('id')) if isinstance(row, dict) and isinstance(row.get('id'), str) else ('invalid', str(index)) for index, row in enumerate(rows))
        if signature in pages:
            warnings.append('来源分页重复，已停止继续翻页')
            break
        pages.add(signature)
        for row in rows:
            if not isinstance(row, dict) or row.get('type') != 'status':
                warnings.append('部分来源条目不可核对，检查范围可能不完整')
                continue
            author, reposter = row.get('author'), row.get('reposted_by')
            belongs = (isinstance(author, dict) and author.get('id') == ref) or (isinstance(reposter, dict) and reposter.get('id') == ref)
            if not belongs:
                continue
            key = row.get('id')
            if not isinstance(key, str) or not NATIVE_ID.fullmatch(key):
                warnings.append('部分帖子缺少数字身份，已有可用内容已保留')
                continue
            observed.add(key)
            if page == 0 and key not in window:
                window.append(key)
            # 先过滤，再读取正文和媒体；引用不可获取时也不收录外层引用帖。
            if not original(row, ref) or key in emitted:
                continue
            try:
                value = entry(row, ref)
            except (ValueError, TypeError, OverflowError, OSError):
                warnings.append('部分原创帖字段不完整，已保留其他可用内容')
                continue
            publish(value)
            emitted.add(key)
            count += 1
        if truncated:
            break
        bottom = pagination.get('bottom')
        if bottom in (None, ''):
            ended = True
            break
        if not isinstance(bottom, str) or len(bottom) > 2048:
            warnings.append('来源分页游标格式不正确，已停止翻页')
            break
        if bottom == cursor or bottom in cursors:
            warnings.append('来源分页游标重复，已停止翻页')
            break
        cursors.add(bottom)
        cursor = bottom
    checked = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    covered = ended or (len(old_window) >= 2 and set(old_window).issubset(observed))
    gap_since = previous.get('gapSince') or (checked if warnings or (not first and not covered) else None)
    gap = bool(gap_since)
    coverage = '初次收录：仅检查公开首页，历史未抓取' if first else '本次原创检查完成；此前仍有尚未覆盖的区间' if previous.get('gapSince') else '已核对上次观察窗口；历史未完整抓取' if covered else '已检查最多两页，尚未覆盖上次观察窗口'
    if not count:
        coverage += '；本次没有可收录的原创帖'
    if warnings:
        coverage = '本次仅取得部分原创帖；' + '；'.join(dict.fromkeys(warnings))
    result = {'profile': candidate, 'coverage': coverage, 'gap': gap, 'warnings': list(dict.fromkeys(warnings))}
    if warnings:
        result.update(status='partial', reason='parse_error', message=coverage)
    else:
        result['xSyncState'] = {'windowIds': window, 'checkedAt': checked, **({'gapSince': gap_since} if gap_since else {})}
    return result
