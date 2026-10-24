"""Peach 官方公开页与归档动态适配；仅收集发布资料和封面。"""
import json
import re
from urllib.parse import urlsplit
from bs4 import BeautifulSoup
from peach_core.official_posts import PatreonConnector
from nectisse_worker.catalog import CATALOG, image_domains
from .metadata.base import FailureReason, SourceFailure
from .metadata.network import allowed_url

ARCHIVES = {'kemono': 'kemono.cr', 'pawchive': 'pawchive.pw', 'coomer': 'coomer.st'}
NATIVE = re.compile(r'^[A-Za-z0-9_.-]{1,64}$')


def canonical(provider, ref):
    if provider in ARCHIVES:
        match = re.fullmatch(r'([a-z0-9_-]{1,32})/([A-Za-z0-9_.-]{1,64})', ref)
        if not match or match[2] in {'.', '..'}:
            raise SourceFailure(FailureReason.UNSUPPORTED, '归档身份需要 service/user_id 或创作者原站主页')
        return f'https://{ARCHIVES[provider]}/{match[1]}/user/{match[2]}'
    if provider == 'patreon':
        if re.fullmatch(r'user/\d+', ref):
            return f'https://www.patreon.com/user?u={ref[5:]}'
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', ref) or ref.lower() in PatreonConnector._RESERVED:
            raise SourceFailure(FailureReason.UNSUPPORTED, '请输入 Patreon 主页或账号')
        return f'https://www.patreon.com/cw/{ref}'
    raise SourceFailure(FailureReason.UNSUPPORTED, '未接入此动态来源')


def identity(provider, value):
    if provider not in ARCHIVES and provider != 'patreon':
        raise SourceFailure(FailureReason.UNSUPPORTED, '未接入此动态来源')
    value = str(value or '').strip()
    if '://' not in value:
        ref = value
        canonical(provider, ref)
        return ref
    if not allowed_url(value, tuple(CATALOG[provider]['domains'])):
        raise SourceFailure(FailureReason.UNSUPPORTED, '请使用当前来源的 HTTPS 创作者主页')
    parsed = urlsplit(value)
    if provider in ARCHIVES:
        match = re.fullmatch(r'/([a-z0-9_-]{1,32})/user/([A-Za-z0-9_.-]{1,64})/?', parsed.path)
        if not match or parsed.query:
            raise SourceFailure(FailureReason.UNSUPPORTED, '需要创作者主页，而不是帖子或全站列表')
        ref = f'{match[1]}/{match[2]}'
    else:
        ref = PatreonConnector.parse_url(provider, parsed, parsed.hostname.removeprefix('www.')).ref
    canonical(provider, ref)
    return ref


def clean(value, limit=1000):
    return BeautifulSoup(str(value or ''), 'html.parser').get_text(' ', strip=True)[:limit]


def request(session, provider, url, config, params):
    from .follow import headers
    response = session.request('GET', url, config=config, headers={**headers(provider, params.get('cookie', '')), 'Accept': 'text/css' if provider in ARCHIVES else 'text/html'}, fingerprint=params.get('transport') == 'fingerprint')
    return response.body


def archive_rows(session, provider, ref, config, params, page=0):
    service, user = ref.split('/')
    url = f'https://{ARCHIVES[provider]}/api/v1/{service}/user/{user}/posts' + (f'?o={page * 50}' if page else '')
    payload = json.loads(request(session, provider, url, config, params))
    rows = payload.get('posts') if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise SourceFailure(FailureReason.PARSE_ERROR, '归档站未返回帖子列表')
    for row in rows[:50]:
        if not isinstance(row, dict) or not NATIVE.fullmatch(str(row.get('id') or '')):
            raise SourceFailure(FailureReason.PARSE_ERROR, '归档帖子缺少原生身份')
        if (row.get('user') and str(row['user']) != user) or (row.get('service') and str(row['service']) != service):
            raise SourceFailure(FailureReason.PARSE_ERROR, '归档帖子不属于所关注身份')
    return rows[:50]


def official_fetch(session, provider, ref, config, params):
    result = PatreonConnector(session, config, params).fetch(ref)
    soup = BeautifulSoup(result.raw_body, 'html.parser')
    title = soup.title.get_text(' ', strip=True) if soup.title else ''
    if re.search(r'^(?:log\s*in|sign\s*in|登录|登入|age verification)', title, re.I):
        raise SourceFailure(FailureReason.AUTH_REQUIRED, '来源返回登录页，请配置有效 Cookie')
    name = soup.select_one('h1, .profile-name, [data-tag="creator-name"]')
    og = soup.select_one('meta[property="og:title"]')
    display = clean(name.get_text(' ', strip=True) if name else og.get('content') if og else '', 200)
    if not display:
        raise SourceFailure(FailureReason.PARSE_ERROR, '公开页未返回可核对的创作者名称')
    # 名称标题也可能出现在错误页或未渲染外壳中，缺少卡片不能证明没有动态。
    if not result.candidates:
        raise SourceFailure(FailureReason.PARSE_ERROR, '公开主页未返回可核对的帖子列表，暂不能确认是否没有动态')
    return result, display


def lookup(params, session, config):
    provider = params['provider']
    ref = identity(provider, params.get('query'))
    if provider in ARCHIVES:
        rows = archive_rows(session, provider, ref, config, params)
        if not rows:
            raise SourceFailure(FailureReason.NOT_FOUND, '归档站未返回可核对的帖子或作者资料')
        name, record, evidence = ref, '归档站创作者身份', '归档 API 返回该服务／用户的帖子；未取得官方显示名，不下载全站索引'
    else:
        _, name = official_fetch(session, provider, ref, config, params)
        record, evidence = '创作者公开主页', '公开主页实际返回的名称；仅检查当前公开卡片，不支持历史分页'
    return [{'provider': provider, 'ref': ref, 'name': name, 'url': canonical(provider, ref), 'aliases': [], 'recordType': record, 'bio': '', 'evidence': evidence}]


def check(params, session, publish, config):
    provider, ref = params['provider'], identity(params['provider'], params.get('ref'))
    seen = set(params.get('seen', [])[:200])
    first = not params.get('initialized')
    overlap, ended = False, False
    paginated = provider in ARCHIVES
    for page in range(1 if first or not paginated else 2):
        if provider in ARCHIVES:
            posts = archive_rows(session, provider, ref, config, params, page)
            ended = len(posts) < 50
            rows = []
            for post in posts:
                key = str(post['id'])
                files = [post.get('file'), *(post.get('attachments') or [])]
                # 封面只取来源给出的静态图片附件；不展开或请求视频、压缩包或网盘链接。
                path = next((str(item.get('path')) for item in files if isinstance(item, dict) and re.fullmatch(r'/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{64}\.(?:jpe?g|png|webp)', str(item.get('path') or ''), re.I)), '')
                thumb = f'https://img.{ARCHIVES[provider]}/thumbnail/data{path}' if path else ''
                content = post.get('content') or post.get('substring') or ''
                rows.append({'externalId': key, 'title': clean(post.get('title'), 1000), 'summary': clean(content, 3000), 'author': params.get('name', ref), 'publishedAt': str(post.get('published') or '')[:100], 'publishedPrecision': 'exact' if post.get('published') else 'unknown', 'url': canonical(provider, ref) + '/post/' + key, 'thumbnailUrl': thumb, 'code': '', 'restricted': False, 'partial': not bool(post.get('content'))})
        else:
            result, name = official_fetch(session, provider, ref, config, params)
            rows = [{'externalId': item.external_id, 'title': clean(item.title, 1000), 'summary': clean(item.summary, 3000), 'author': clean(item.author or name, 200), 'publishedAt': item.published_at or '', 'publishedPrecision': str(item.extra.get('published_precision') or 'unknown'), 'url': item.url or '', 'thumbnailUrl': item.thumb_url or '', 'code': '', 'restricted': False, 'partial': True} for item in result.candidates]
        for entry in rows:
            overlap |= entry['externalId'] in seen
            if not allowed_url(entry['thumbnailUrl'], image_domains(provider)):
                entry['thumbnailUrl'] = ''
            publish(entry)
        if overlap or ended:
            break
    coverage = '初次收录：仅检查来源首页，历史未抓取' if first else '已覆盖到上次记录' if overlap else '来源公开首页；不支持历史分页' if not paginated else '已到来源列表末尾' if ended else '已检查最多两页，尚未覆盖到上次记录'
    return {'coverage': coverage, 'gap': not first and not overlap and not ended, 'warnings': []}
