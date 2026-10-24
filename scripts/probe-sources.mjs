// 显式的一站一项在线核验；不读取或复制用户凭据，不登记用户关注。
import { PythonTaskHost } from '../src/main/platform/python/python-host.ts';
import { pythonLayout } from '../src/main/platform/python/python-layout.ts';
import { planQuery } from '../src/main/features/metadata/metadata-input.ts';
import { METADATA_IDS, FOLLOW_IDS, SOURCE_BY_ID } from '@shared/sources.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const [kind, source, input, ...flags] = process.argv.slice(2);
if (!(kind === 'metadata' ? METADATA_IDS : kind === 'follow' ? FOLLOW_IDS : []).includes(source) || !input) throw new Error('用法：node --import tsx scripts/probe-sources.mjs <metadata|follow> <来源键> <编号或主页> [--proxy http://127.0.0.1:7890]');
const proxy = flags.includes('--proxy') ? flags[flags.indexOf('--proxy') + 1] || '' : '';
if (proxy) { const url = new URL(proxy); if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || url.username || url.password) throw new Error('代理格式不支持'); }
const appPath = flags.includes('--app') ? flags[flags.indexOf('--app') + 1] : '';
const host = new PythonTaskHost(pythonLayout(appPath ? join(resolve(appPath), 'Contents/Resources') : root, !!appPath));
let last = 0;
const records = [];
try {
	const params = kind === 'metadata' ? { ...planQuery({ query: input, sources: [source], force: true }), source, proxy } : { provider: source, query: input, proxy };
	params.transport = flags.includes('--standard') ? 'httpx' : SOURCE_BY_ID[source].engine === 'amane' || !['dmm', 'r18dev', 'fc2'].includes(source) ? 'fingerprint' : 'httpx';
	const result = await host.run(kind === 'metadata' ? 'metadata.query' : 'follow.lookup', params, { timeoutMs: 60_000, onRequest: async () => { await delay(Math.max(0, last + (source === 'javdb' ? 3000 : 2000) - Date.now())); last = Date.now(); }, onProgress: payload => { if (payload.event === 'record') records.push({ source: payload.record.source, identity: payload.record.code, titlePresent: !!payload.record.title, people: payload.record.people.length, covers: payload.record.covers.length, deliveryDatePresent: !!payload.record.deliveryDate }); } });
	const report = { checkedAt: new Date().toISOString(), source, kind, status: result.status, reason: result.reason, message: result.message, requests: result.requests, records, candidates: result.candidates?.map(row => ({ ref: row.ref, namePresent: !!row.name, urlPresent: !!row.url })) };
	if (kind === 'follow' && flags.includes('--check') && result.candidates?.[0]) {
		let entries = 0; let summaries = 0;
		const checked = await host.run('follow.check', { ...params, ref: result.candidates[0].ref, name: result.candidates[0].name, initialized: false, seen: [] }, { timeoutMs: 60_000, onRequest: async () => { await delay(Math.max(0, last + 2000 - Date.now())); last = Date.now(); }, onProgress: payload => { if (payload.event === 'entry') { entries++; if (payload.entry.summary) summaries++; } } });
		report.check = { status: checked.status, reason: checked.reason, requests: checked.requests, entries, summaries, coverage: checked.coverage };
	}
	await mkdir(new URL('../.test-output/probes/', import.meta.url), { recursive: true });
	await writeFile(new URL(`../.test-output/probes/source-${source}.json`, import.meta.url), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
} finally { await host.shutdown(); }
