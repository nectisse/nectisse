import { fileURLToPath } from 'node:url'
import { PythonTaskHost } from '../../src/main/platform/python/python-host.ts'
import { pythonLayout } from '../../src/main/platform/python/python-layout.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const host = new PythonTaskHost(pythonLayout(root, false), { diagnostics: true })
let worker
await host.run('diagnostics.block', {}, {
  onReady: pid => { worker = pid },
  onProgress: payload => process.send({ worker, child: payload.childPid }),
})
