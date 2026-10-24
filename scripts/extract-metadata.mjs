// 从工作区参考快照提取独立来源，记录原文件哈希；不修改参考项目。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const upstream = join(root, 'ref/peach/src/peach');
const destination = join(root, 'python/vendor/peach_core');
await mkdir(join(destination, 'sources'), { recursive: true });
await writeFile(join(destination, 'sources/__init__.py'), '"""Peach 0.46.1 的独立资料来源；来源和修改见上级 UPSTREAM.md。"""\n');
const records = [];
for (const name of ['r18dev', 'dmm', 'fc2', 'onepondo', 'fc2cmadb', 'fc2ppvdb', 'javten', 'javarchive', 'avbase', 'javbus', 'javdb', 'seesaa']) {
	const relative = `sources/${name}.py`;
	const original = await readFile(join(upstream, relative), 'utf8');
	let adapted = original.replace('from ..metadata import identifies_code', 'from ..identity import identifies_code')
		.replace('from .base import ', 'from nectisse_worker.metadata.base import ')
		.replace('from ..jav_cover_fetch import Unavailable', 'from nectisse_worker.metadata.base import SourceFailure as Unavailable')
		.replace('from ..jav_cover_fetch import NotFound', 'from nectisse_worker.metadata.base import SourceNotFound as NotFound')
		.replace('from ..scraping_access import SourcePaused', 'from nectisse_worker.metadata.base import SourceFailure as SourcePaused')
		.replace('from ..jav_cover_fetch import THUMBNAIL, is_cross_product_cover', 'from ..cover_identity import THUMBNAIL, is_cross_product_cover');
	if (name === 'javdb') {
		const begin = adapted.indexOf('    def resources('); const end = adapted.indexOf('    def search_url(', begin);
		if (begin < 0 || end < 0) throw new Error('JavDB 资料提取边界未识别');
		adapted = adapted.slice(0, begin) + adapted.slice(end);
		adapted = adapted.slice(0, adapted.indexOf('\ndef parse_magnets('));
	}
	if (name === 'seesaa') {
		adapted = adapted.replace('from ..metadata import MetadataProviderError, auth_error, auth_wall_reason, validate_provider_code', 'from nectisse_worker.metadata.compat import MetadataProviderError, auth_error, auth_wall_reason, validate_provider_code').replace('from ..scripting import HostLimiter\n', '');
		const begin = adapted.indexOf('class WikiPages:'); const end = adapted.indexOf('class SeesaaSource(', begin);
		if (begin < 0 || end < 0) throw new Error('Wiki 纯解析提取边界未识别');
		adapted = adapted.slice(0, begin) + adapted.slice(end);
		adapted = adapted.replaceAll('session.transport.get(', 'session.wiki_get(').replace('SEARCH_PAGES = 8', 'SEARCH_PAGES = 3').replace('LABEL_PAGES = 4', 'LABEL_PAGES = 1');
	}
	if (name === 'r18dev') adapted = adapted.replace('jacket = (raw.get(\'images\') or {}).get(\'jacket_image\')', "jacket = (raw.get('images') or {}).get('jacket_image')\n        # r18.dev 当前返回 large/large2 对象；忽略仅含空格的候选，兼容旧字符串形态。\n        if isinstance(jacket, dict):\n            jacket = next((value.strip() for key in ('large', 'large2') if isinstance(value := jacket.get(key), str) and value.strip()), '')");
	await writeFile(join(destination, relative), adapted);
	records.push({ path: relative, upstreamSha256: createHash('sha256').update(original).digest('hex'), extractedSha256: createHash('sha256').update(adapted).digest('hex') });
}
const metadata = await readFile(join(upstream, 'metadata.py'), 'utf8');
const identity = metadata.slice(metadata.indexOf('IDENTITY_FIELDS ='), metadata.indexOf('def collapse_repeated_phrase')).trim();
await writeFile(join(destination, 'identity.py'), '"""提取自 Peach metadata.py 的身份判定；函数与常量保持原实现。"""\nimport re\nfrom urllib.parse import urlsplit\nfrom .catalog_rules import same_release_code, code_query_variants, normalise_code_key\n\n' + identity + '\n');
const cover = await readFile(join(upstream, 'jav_cover_fetch.py'), 'utf8');
const coverRules = cover.slice(cover.indexOf('_DMM_CID ='), cover.indexOf('def _is_prestige')).trim();
const thumbnail = cover.split('\n').find(line => line.startsWith('THUMBNAIL ='));
if (!thumbnail) throw new Error('封面缩略图规则未识别');
await writeFile(join(destination, 'cover_identity.py'), '"""提取自 Peach jav_cover_fetch.py 的跨作品封面判定。"""\nimport re\nfrom urllib.parse import urlparse\nfrom .catalog_rules import normalise_code_key, code_letter_stem\n\nMIN_WIDTH = 700\nSMALL_MIN_WIDTH = 240\n' + thumbnail + '\n\n' + coverRules + '\n');
for (const path of ['metadata.py', 'jav_cover_fetch.py']) {
	const extractedPath = path === 'metadata.py' ? 'identity.py' : 'cover_identity.py';
	records.push({ path, upstreamSha256: createHash('sha256').update(await readFile(join(upstream, path))).digest('hex'), extractedPath, extractedSha256: createHash('sha256').update(await readFile(join(destination, extractedPath))).digest('hex'), extractedSections: path === 'metadata.py' ? 'IDENTITY_FIELDS 到 identifies_code' : '_DMM_CID 到 is_cross_product_cover；MIN_WIDTH/SMALL_MIN_WIDTH' });
}
await writeFile(join(destination, '../metadata-extraction.json'), JSON.stringify({ peachVersion: '0.46.1', records }, null, 2) + '\n');
console.log('已提取 Peach 的资料连接器、三份 Wiki 解析及身份规则。');
