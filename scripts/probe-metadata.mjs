// 显式、限量的真实来源验证；不读用户资料库，不采集视频或其他资源。
import { PythonTaskHost } from '../src/main/python-host.ts';
import { pythonLayout } from '../src/main/python-layout.ts';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { MetadataService } from '../src/main/metadata-service.ts';
import { planQuery } from '../src/main/metadata-input.ts';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = process.argv[2];
const code = process.argv[3];
if (!['r18dev', 'dmm', 'fc2', 'all'].includes(source) || !code) throw new Error('用法：node --import tsx scripts/probe-metadata.mjs <r18dev|dmm|fc2|all> <编号或标题> [--covers]');
// 与应用保持同样的编号家族和链接分流；all 只包含此脚本原有的三个来源。
const sources = source === 'all' ? ['dmm', 'r18dev', 'fc2'] : [source];
const plan = planQuery({ query: code, sources, force: true });
const host = new PythonTaskHost(pythonLayout(root, false));
let last = 0;
const system = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
const enabled = /^\s*HTTPSEnable\s*:\s*1\s*$/m.test(system);
const proxyHost = /^\s*HTTPSProxy\s*:\s*(\S+)\s*$/m.exec(system)?.[1];
const proxyPort = /^\s*HTTPSPort\s*:\s*(\d+)\s*$/m.exec(system)?.[1];
const proxy = enabled && proxyHost && proxyPort ? `http://${proxyHost}:${proxyPort}` : '';
try {
	if (process.argv.includes('--covers')) {
		const directory = await mkdtemp(join(tmpdir(), 'nectisse-live-probe-'));
		const service = new MetadataService(directory, host, async () => proxy);
		try {
			await service.initialize();
			const reply = await service.query({ query: code, sources, force: true });
			if (!reply.ok) throw new Error(reply.message);
			const deadline = Date.now() + 180_000;
			while (service.getState().activeId) { if (Date.now() > deadline) throw new Error('Probe exceeded deadline'); await delay(100); }
			const task = service.getState().tasks[0];
			const report = { checkedAt: new Date().toISOString(), source, kind: task.plan.kind, status: task.status, requests: task.requests, outcomes: task.outcomes, records: task.records.map(record => ({ code: record.code, source: record.source, titlePresent: !!record.title, people: record.people.length, tags: record.tags.length, covers: record.covers.map(cover => ({ cached: !!cover.asset, error: cover.error, width: cover.asset?.width, height: cover.asset?.height })), warnings: record.warnings })) };
			await mkdir(join(root, '.test-output/probes'), { recursive: true });
			await writeFile(join(root, '.test-output/probes', `${source}-covers.json`), JSON.stringify(report, null, 2) + '\n');
			console.log(JSON.stringify(report, null, 2));
		} finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
	} else {
		for (const currentSource of plan.sources) {
			const records = [];
			const outcome = await host.run('metadata.query', { ...plan, source: currentSource, proxy }, {
				timeoutMs: 60_000,
				onRequest: async () => { await delay(Math.max(0, last + 2000 - Date.now())); last = Date.now(); },
				onProgress: payload => { if (payload.event === 'record') records.push(payload.record); },
			});
			const report = { checkedAt: new Date().toISOString(), source: currentSource, kind: plan.kind, code: plan.code, outcome, records: records.map(record => ({ code: record.code, titlePresent: !!record.title, people: record.people.length, tags: record.tags.length, coverCandidates: record.covers.length, fields: ['studio', 'label', 'series', 'releaseDate', 'description', 'seller'].filter(key => !!record[key]), warnings: record.warnings })) };
			await mkdir(join(root, '.test-output/probes'), { recursive: true });
			await writeFile(join(root, '.test-output/probes', `${currentSource}.json`), JSON.stringify(report, null, 2) + '\n');
			console.log(JSON.stringify(report, null, 2));
		}
	}
} finally { await host.shutdown(); }
