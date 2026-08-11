import { creativeWorkerConfig } from '../lib/server/creative/config'
import { creativePool } from '../lib/server/creative/db'
import { runCreativeWorkerBatch } from '../lib/server/creative/worker'

let stopping = false
process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })

async function main() {
  const config = creativeWorkerConfig()
  const workerId = `creative_${process.pid}`
  let failureCount = 0
  while (!stopping) {
    try {
      const claimed = await runCreativeWorkerBatch(config.concurrency, workerId)
      failureCount = 0
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, config.intervalMs))
    } catch (error) {
      failureCount += 1
      const delay = Math.min(30_000, config.intervalMs * 2 ** Math.min(5, failureCount - 1))
      process.stderr.write(`[creative-worker] batch failed; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}\n`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  await creativePool().end()
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
