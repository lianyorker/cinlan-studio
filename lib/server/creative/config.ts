import { resolve } from 'node:path'

export function creativeCoreConfigured() {
  return Boolean(process.env.DATABASE_URL?.trim())
}

export function creativeAssetRoot() {
  return resolve(process.env.CREATIVE_ASSET_STORAGE_DIR?.trim() || resolve(process.cwd(), 'data', 'assets'))
}

export function creativePlannerConfig() {
  return {
    enabled: process.env.CREATIVE_PLANNER_ENABLED !== 'false',
    model: process.env.CREATIVE_PLANNER_MODEL?.trim() || 'gpt-5.2',
    effort: process.env.CREATIVE_PLANNER_EFFORT?.trim() || 'xhigh',
  }
}

export function creativeWorkerConfig() {
  const concurrency = Number(process.env.CREATIVE_WORKER_CONCURRENCY || 2)
  const intervalMs = Number(process.env.CREATIVE_WORKER_INTERVAL_MS || 1000)
  return {
    concurrency: Number.isFinite(concurrency) ? Math.min(8, Math.max(1, concurrency)) : 2,
    intervalMs: Number.isFinite(intervalMs) ? Math.min(30_000, Math.max(250, intervalMs)) : 1000,
  }
}

export function creativeInProcessWorkerEnabled() {
  if (process.env.NODE_ENV !== 'production') return true
  return process.env.CREATIVE_IN_PROCESS_WORKER === 'true'
}
