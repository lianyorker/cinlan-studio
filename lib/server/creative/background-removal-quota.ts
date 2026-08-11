import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BackgroundRemovalQuota } from '@/lib/background-removal-types'
import { sub2apiFetch } from '../sub2api'
import { refreshStudioSession } from '../studio-auth'
import type { StudioSession } from '../session'
import { creativeQuery, creativeTransaction } from './db'
import { CreativeCoreError } from './errors'
import type { AssetRecord, JobRecord } from './repository'

const HIGH_BALANCE_LIMIT = 20
const STANDARD_LIMIT = 5

interface UsageRecord {
  status: 'reserved' | 'consumed' | 'released'
}

export function backgroundRemovalLimit(balance: number | null) {
  return balance !== null && balance > 500 ? HIGH_BALANCE_LIMIT : STANDARD_LIMIT
}

async function currentBalance(session: StudioSession) {
  if (session.authMode !== 'login' || !session.accessToken) return null
  try {
    const active = await refreshStudioSession(session)
    const user = await sub2apiFetch<{ balance?: number }>('/api/v1/auth/me', { accessToken: active.accessToken })
    const balance = Number(user.balance)
    return Number.isFinite(balance) ? balance : null
  } catch {
    // A temporary Sub2API balance failure must not take down background removal.
    // The conservative daily limit is applied when the balance is unavailable.
    return null
  }
}

function quotaFromRow(row: { usage_date: string | Date; used: string | number }, limit: number): BackgroundRemovalQuota {
  const usageDate = typeof row.usage_date === 'string'
    ? row.usage_date.slice(0, 10)
    : row.usage_date.toISOString().slice(0, 10)
  const used = Number(row.used)
  const reset = new Date(`${usageDate}T16:00:00.000Z`)
  reset.setUTCDate(reset.getUTCDate() + 1)
  return {
    usage_date: usageDate,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resets_at: reset.toISOString(),
  }
}

async function quotaWithClient(client: PoolClient, ownerId: string, limit: number) {
  const result = await client.query<{ usage_date: string; used: string }>(
    `SELECT timezone('Asia/Shanghai', now())::date AS usage_date,
            count(*) FILTER (WHERE status IN ('reserved', 'consumed'))::text AS used
       FROM background_removal_usage
      WHERE owner_id = $1
        AND usage_date = timezone('Asia/Shanghai', now())::date`,
    [ownerId]
  )
  return quotaFromRow(result.rows[0], limit)
}

export async function backgroundRemovalQuota(ownerId: string, session: StudioSession) {
  const balance = await currentBalance(session)
  const limit = backgroundRemovalLimit(balance)
  const result = await creativeQuery<{ usage_date: string; used: string }>(
    `SELECT timezone('Asia/Shanghai', now())::date AS usage_date,
            count(*) FILTER (WHERE status IN ('reserved', 'consumed'))::text AS used
       FROM background_removal_usage
      WHERE owner_id = $1
        AND usage_date = timezone('Asia/Shanghai', now())::date`,
    [ownerId]
  )
  return { balance, quota: quotaFromRow(result.rows[0], limit) }
}

export async function createBackgroundRemovalJob(input: {
  ownerId: string
  session: StudioSession
  sourceAssetId: string
  idempotencyKey: string
}) {
  const balance = await currentBalance(input.session)
  const limit = backgroundRemovalLimit(balance)
  return creativeTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`background-removal:${input.ownerId}`])
    const sourceResult = await client.query<AssetRecord>(
      `SELECT * FROM creative_assets WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
      [input.sourceAssetId, input.ownerId]
    )
    const source = sourceResult.rows[0]
    if (!source) throw new CreativeCoreError(404, 'ASSET_NOT_FOUND', 'Creative asset was not found')
    if (!source.mime_type.startsWith('image/')) throw new CreativeCoreError(400, 'BACKGROUND_REMOVAL_IMAGE_REQUIRED', 'Background removal requires an image asset')

    const reusable = await client.query<JobRecord>(
      `SELECT j.*
         FROM creative_jobs j
         JOIN creative_job_assets ja ON ja.job_id = j.id AND ja.role = 'input' AND ja.ordinal = 0
        WHERE j.owner_id = $1
          AND ja.asset_id = $2
          AND j.parameters->>'operation' = 'background_removal'
          AND j.deleted_at IS NULL
          AND j.status IN ('CREATED','ANALYZING','READY','QUEUED','RUNNING','VALIDATING','COMPLETED','PARTIAL_SUCCESS','CANCEL_REQUESTED')
        ORDER BY j.created_at DESC
        LIMIT 1`,
      [input.ownerId, input.sourceAssetId]
    )
    if (reusable.rows[0]) {
      return { job: reusable.rows[0], quota: await quotaWithClient(client, input.ownerId, limit), reused: true }
    }

    const idempotent = await client.query<JobRecord>(
      `SELECT * FROM creative_jobs WHERE owner_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL`,
      [input.ownerId, input.idempotencyKey]
    )
    if (idempotent.rows[0]) {
      return { job: idempotent.rows[0], quota: await quotaWithClient(client, input.ownerId, limit), reused: true }
    }

    const quota = await quotaWithClient(client, input.ownerId, limit)
    if (quota.remaining <= 0) {
      throw new CreativeCoreError(429, 'BACKGROUND_REMOVAL_QUOTA_EXCEEDED', 'Daily background-removal quota has been reached', quota)
    }

    const jobId = `job_${randomUUID()}`
    const parameters = {
      operation: 'background_removal',
      provider: 'aliyun',
      source_asset_id: source.id,
      count: 1,
    }
    const inserted = await client.query<JobRecord>(
      `INSERT INTO creative_jobs(id, owner_id, mode, status, model, prompt_original, parameters, idempotency_key, max_attempts)
       VALUES($1,$2,'EDIT','CREATED','aliyun-segment-common-image','Remove image background',$3::jsonb,$4,2)
       RETURNING *`,
      [jobId, input.ownerId, JSON.stringify(parameters), input.idempotencyKey]
    )
    await client.query(
      `INSERT INTO creative_job_assets(job_id, asset_id, role, ordinal) VALUES($1,$2,'input',0)`,
      [jobId, source.id]
    )
    await client.query(
      `INSERT INTO creative_job_events(job_id, type, phase, message_key, payload)
       VALUES($1,'status','created','creative.activity.background_removal_created',$2::jsonb)`,
      [jobId, JSON.stringify({ source_asset_id: source.id })]
    )
    await client.query(
      `INSERT INTO background_removal_usage(id, owner_id, usage_date, job_id, source_asset_id, idempotency_key, status, daily_limit, balance_snapshot)
       VALUES($1,$2,timezone('Asia/Shanghai', now())::date,$3,$4,$5,'reserved',$6,$7)`,
      [`bru_${randomUUID()}`, input.ownerId, jobId, source.id, input.idempotencyKey, limit, balance]
    )
    return {
      job: inserted.rows[0],
      quota: { ...quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) },
      reused: false,
    }
  })
}

export async function consumeBackgroundRemovalUsage(jobId: string) {
  const result = await creativeQuery<UsageRecord>(
    `UPDATE background_removal_usage
        SET status = 'consumed', updated_at = now()
      WHERE job_id = $1 AND status = 'reserved'
      RETURNING status`,
    [jobId]
  )
  return result.rows[0]?.status === 'consumed'
}

export async function recordBackgroundRemovalProviderRequest(jobId: string, requestId: string) {
  await creativeQuery(
    `UPDATE background_removal_usage
        SET provider_request_id = $2, updated_at = now()
      WHERE job_id = $1`,
    [jobId, requestId]
  )
}

export async function restoreBackgroundRemovalReservation(jobId: string) {
  await creativeQuery(
    `UPDATE background_removal_usage
        SET status = 'reserved', updated_at = now()
      WHERE job_id = $1
        AND status = 'consumed'
        AND provider_request_id IS NULL`,
    [jobId]
  )
}

export async function releaseBackgroundRemovalUsage(jobId: string) {
  await creativeQuery(
    `UPDATE background_removal_usage
        SET status = 'released', updated_at = now()
      WHERE job_id = $1
        AND status IN ('reserved', 'consumed')
        AND provider_request_id IS NULL`,
    [jobId]
  )
}
