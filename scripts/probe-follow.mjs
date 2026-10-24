import { PythonTaskHost } from '../src/main/platform/python/python-host.ts';
import { pythonLayout } from '../src/main/platform/python/python-layout.ts';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url));
const [provider, query] = process.argv.slice(2);
if (!['fanbox', 'javdb'].includes(provider) || !query) throw new Error('用法：node --import tsx scripts/probe-follow.mjs <fanbox|javdb> <主页、账号或演员名>');
const system = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
const hostName = /^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m.exec(system)?.[1];
const port = /^\s*HTTPSPort\s*:\s*(\d+)\s*$/m.exec(system)?.[1];
const proxy = /^\s*HTTPSEnable\s*:\s*1\s*$/m.test(system) && hostName && port ? `http://${hostName}:${port}` : '';
const host = new PythonTaskHost(pythonLayout(root, false));
let last = 0;
const options = { timeoutMs: 60_000, onRequest: async () => { await delay(Math.max(0, last + 2000 - Date.now())); last = Date.now(); } };
try {
	const result = await host.run('follow.lookup', { provider, query, proxy, transport: process.argv.includes('--fingerprint') ? 'fingerprint' : 'httpx' }, options);
	const entries = [];
	const checked = result.candidates?.[0] && process.argv.includes('--check') ? await host.run('follow.check', { provider, ref: result.candidates[0].ref, name: result.candidates[0].name, proxy, transport: process.argv.includes('--fingerprint') ? 'fingerprint' : 'httpx', initialized: false, seen: [] }, { ...options, onProgress: payload => { if (payload.event === 'entry') entries.push({ idPresent: !!payload.entry.externalId, titlePresent: !!payload.entry.title, summaryPresent: !!payload.entry.summary, restricted: payload.entry.restricted }); } }) : undefined;
	const report = { checkedAt: new Date().toISOString(), provider, lookup: { status: result.status, reason: result.reason, message: result.message, requests: result.requests, candidates: result.candidates?.map(row => ({ ref: row.ref, namePresent: !!row.name, urlPresent: !!row.url })) }, checked, entries };
	await mkdir(new URL('../.test-output/probes/', import.meta.url), { recursive: true });
	await writeFile(new URL(`../.test-output/probes/follow-${provider}.json`, import.meta.url), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally { await host.shutdown(); }
