// 有限的真实查询；隔离 profile，不读取应用收藏、订阅、Cookie 或浏览器默认资料。
import { PythonTaskHost } from '../src/main/python-host.ts';
import { pythonLayout } from '../src/main/python-layout.ts';
import { planQuery } from '../src/main/metadata-input.ts';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { TaskCancelledError } from '../src/main/python-host.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const code = process.argv[2] || 'FC2-PPV-4898837';
const proxy = process.argv[3] || '';
const profile = await mkdtemp(join(tmpdir(), 'nectisse-browser-probe-'));
let host = new PythonTaskHost(pythonLayout(root, false), { browserProfile: profile });
const plan = planQuery({ query: code, sources: ['fc2ppvdb'], force: true });
const report = [];
let last = 0;
try {
	for (let round = 1; round <= 3; round++) {
		if (round === 3) {
			await host.shutdown();
			host = new PythonTaskHost(pythonLayout(root, false), { browserProfile: profile });
		}
		const records = [];
		const stages = [];
		const started = Date.now();
		const outcome = await host.run(
			'metadata.query',
			{ ...plan, source: 'fc2ppvdb', transport: 'browser', proxy },
			{
				timeoutMs: 240_000,
				onReady: (pid) => console.log(JSON.stringify({ round, workerPid: pid })),
				onRequest: async ({ host: hostname, sequence }) => {
					await delay(Math.max(0, last + 2000 - Date.now()));
					last = Date.now();
					console.log(JSON.stringify({ round, navigation: sequence, host: hostname }));
				},
				onProgress: (payload) => {
					if (payload.event === 'browser') {
						stages.push(payload);
						console.log(JSON.stringify({ round, ...payload }));
					}
					if (payload.event === 'record') {
						const record = payload.record;
						records.push({
							code: record.code,
							source: record.source,
							titlePresent: !!record.title,
							people: record.people.length,
							sellerPresent: !!record.seller,
							releaseDate: record.releaseDate,
							tags: record.tags.length,
							covers: record.covers.length,
						});
					}
				},
			},
		);
		report.push({ round, durationMs: Date.now() - started, outcome, records, stages });
		console.log(JSON.stringify(report.at(-1)));
		if (outcome.status !== 'success') {
			break;
		}
	}
	if (report.length === 3 && report.every((item) => item.outcome.status === 'success')) {
		const controller = new AbortController();
		const browserPid = report[2].stages.find((item) => item.browserPid)?.browserPid;
		const [workerPid] = host.activePids;
		await assert.rejects(
			host.run(
				'metadata.query',
				{ ...plan, source: 'fc2ppvdb', transport: 'browser', proxy },
				{
					signal: controller.signal,
					onRequest: async () => {},
					onProgress: (payload) => {
						if (payload.event === 'browser') controller.abort();
					},
				},
			),
			TaskCancelledError,
		);
		for (const pid of [workerPid, browserPid]) {
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					process.kill(pid, 0);
				} catch {
					break;
				}
				await delay(50);
			}
			assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
		}
		console.log(JSON.stringify({ cancelled: true, workerReaped: true, browserReaped: true }));
	}
	await mkdir(join(root, '.test-output/probes'), { recursive: true });
	await writeFile(join(root, '.test-output/probes/fc2ppvdb-browser.json'), JSON.stringify({ checkedAt: new Date().toISOString(), report }, null, 2));
} finally {
	await host.shutdown();
	await rm(profile, { recursive: true, force: true });
}
