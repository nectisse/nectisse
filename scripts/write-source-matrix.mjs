import { mkdir, readFile, writeFile } from 'node:fs/promises';
const catalog = JSON.parse(await readFile(new URL('../python/src/nectisse_worker/source_catalog.json', import.meta.url), 'utf8'));
const sources = Object.values(catalog);
const lines = ['# Nectisse 来源支持矩阵', '', `${sources.length} 个来源身份统一登记；${sources.filter(row => row.metadata).length} 个支持作品资料派发，${sources.filter(row => row.follow).length} 个支持订阅派发，JavDB 与 JavTao 同时属于两类。${sources.filter(row => !row.metadata && !row.follow).length} 个来源只登记前置条件，开关不可启用。Gofile 等文件资源站和历史来源名不作为采集能力加入。`, '', '“可派发”表示连接器与本地任务管线已经接通，不代表每个站点都已经在线成功。登录、地区与浏览器验证状态由每次实际查询更新。新增来源默认关闭；原有设置、代理和订阅保留。', '', '| 来源 | 实现 | 作品资料 | 封面 | 订阅 | 方式与验证边界 |', '| --- | --- | --- | --- | --- | --- |'];
for (const [id, row] of Object.entries(catalog)) {
	lines.push(`| ${row.name} (${id}) | ${row.engine === 'amane' ? 'amane 0.20.0' : row.engine === 'peach' ? 'Peach 提取／适配' : row.engine === 'fxembed' ? 'FxEmbed API v2' : row.engine === 'nectisse' ? 'Nectisse 公开页适配' : '前置条件登记'} | ${row.metadata ? '可派发' : '—'} | ${row.metadata && row.images.length && id !== 'javdb' ? '候选与缓存' : id === 'javdb' ? '作品图仅核验；头像与新作图缓存' : row.follow ? '动态缩略图缓存' : '—'} | ${row.follow ? ['javdb', 'javtao'].includes(id) ? '演员新作' : row.group : '—'} | ${row.note.replaceAll('|', '／')} |`);
}
lines.push('', 'JavDB 演员主页与头像已有本机在线成功样本；作品资料、演员查询与新作订阅的验证范围分别记录，部分页面仍可能受登录或出口限制。', '', 'amane 的片商官网入口沿用其 29 家片商的编号前缀映射。当前 S1 样例已取得真实资料，其他片商没有逐一在线验收。FC2PPV-DB 已接入实际 Chrome / Edge 的独立浏览器会话，并有编号查询成功样本；其他来源的浏览器流程仍各自待验证，不能以 curl_cffi 或 Electron Chromium 代替。', '', '归档站按 service/user_id 保存身份，显示原作者发布字段和本地发现时间；不把归档收录称作作者实时更新。不下载全站创作者索引，不按资源附件筛掉公告。Patreon 公开页不支持历史翻页，缺口会显示。', '', '复现矩阵：`node scripts/write-source-matrix.mjs`。来源事实以 `python/src/nectisse_worker/source_catalog.json`、提取清单和实际验证报告为准。', '');
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/SOURCE_SUPPORT.md', import.meta.url), lines.join('\n'));
console.log(`已生成 ${sources.length} 项来源支持矩阵。`);
