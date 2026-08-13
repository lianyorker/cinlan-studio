import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { CreativeEvent, CreativeJob, CreativeJobMode, CreativeJobStatus, CreativePlan } from '@/lib/creative-types'
import { creativeQuery, creativeTransaction } from './db'
import { CreativeCoreError } from './errors'

type Json = Record<string, unknown>

export interface AssetRecord {
  id: string
  owner_id: string
  kind: 'reference' | 'mask' | 'result' | 'thumbnail'
  original_name: string | null
  mime_type: string
  byte_size: number
  sha256: string | null
  storage_path: string | null
  external_url: string | null
  width: number | null
  height: number | null
  created_at: Date
}

export interface JobRecord {
  id: string
  owner_id: string
  mode: CreativeJobMode
  status: CreativeJobStatus
  model: string
  prompt_original: string
  prompt_compiled: string | null
  plan: CreativePlan | null
  parameters: Json
  provider_task_id: string | null
  provider_request_id: string | null
  idempotency_key: string
  attempt_count: number
  max_attempts: number
  poll_count: number
  result_count: number
  error_code: string | null
  error_message: string | null
  lease_owner: string | null
  lease_expires_at: Date | null
  next_run_at: Date
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

export async function upsertCreativeOwner(owner: { id: string; kind: string; displayName: string | null }, encryptedApiKey?: string) {
  await creativeTransaction(async (client) => {
    await client.query(
      `INSERT INTO creative_owners(id, kind, display_name)
       VALUES($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [owner.id, owner.kind, owner.displayName]
    )
    if (encryptedApiKey) {
      await client.query(
        `INSERT INTO creative_credentials(owner_id, encrypted_api_key)
         VALUES($1, $2)
         ON CONFLICT(owner_id) DO UPDATE SET encrypted_api_key = EXCLUDED.encrypted_api_key, updated_at = now()`,
        [owner.id, encryptedApiKey]
      )
    }
  })
}

export async function creativeCredential(ownerId: string) {
  const result = await creativeQuery<{ encrypted_api_key: string }>(
    'SELECT encrypted_api_key FROM creative_credentials WHERE owner_id = $1',
    [ownerId]
  )
  if (!result.rows[0]) throw new CreativeCoreError(503, 'CREATIVE_CREDENTIAL_UNAVAILABLE', 'Creative Core credential is unavailable')
  return result.rows[0].encrypted_api_key
}

export async function createAssetRecord(input: Omit<AssetRecord, 'created_at'>) {
  const result = await creativeQuery<AssetRecord>(
    `INSERT INTO creative_assets(id, owner_id, kind, original_name, mime_type, byte_size, sha256, storage_path, external_url, width, height)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [input.id, input.owner_id, input.kind, input.original_name, input.mime_type, input.byte_size, input.sha256, input.storage_path, input.external_url, input.width, input.height]
  )
  return result.rows[0]
}

export async function findAssetByHash(ownerId: string, sha256: string, kind: AssetRecord['kind']) {
  const result = await creativeQuery<AssetRecord>(
    `SELECT * FROM creative_assets WHERE owner_id = $1 AND sha256 = $2 AND kind = $3 AND deleted_at IS NULL LIMIT 1`,
    [ownerId, sha256, kind]
  )
  return result.rows[0] ?? null
}

export async function getAssetForOwner(ownerId: string, assetId: string) {
  const result = await creativeQuery<AssetRecord>(
    `SELECT * FROM creative_assets WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [assetId, ownerId]
  )
  if (!result.rows[0]) throw new CreativeCoreError(404, 'ASSET_NOT_FOUND', 'Creative asset was not found')
  return result.rows[0]
}

export async function getAssetInternal(assetId: string) {
  const result = await creativeQuery<AssetRecord>('SELECT * FROM creative_assets WHERE id = $1 AND deleted_at IS NULL', [assetId])
  if (!result.rows[0]) throw new CreativeCoreError(404, 'ASSET_NOT_FOUND', 'Creative asset was not found')
  return result.rows[0]
}

export async function softDeleteAsset(ownerId: string, assetId: string) {
  const result = await creativeQuery(
    `UPDATE creative_assets SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [assetId, ownerId]
  )
  if (!result.rowCount) throw new CreativeCoreError(404, 'ASSET_NOT_FOUND', 'Creative asset was not found')
}

export async function createCreativeJob(input: {
  ownerId: string
  mode: CreativeJobMode
  model: string
  prompt: string
  parameters: Json
  idempotencyKey: string
  inputAssetIds: string[]
  maskAssetId?: string
}) {
  return creativeTransaction(async (client) => {
    const existing = await client.query<JobRecord>(
      'SELECT * FROM creative_jobs WHERE owner_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL',
      [input.ownerId, input.idempotencyKey]
    )
    if (existing.rows[0]) return existing.rows[0]

    const ids = [...input.inputAssetIds, ...(input.maskAssetId ? [input.maskAssetId] : [])]
    if (ids.length) {
      const owned = await client.query<{ id: string }>(
        `SELECT id FROM creative_assets WHERE owner_id = $1 AND id = ANY($2::text[]) AND deleted_at IS NULL`,
        [input.ownerId, ids]
      )
      if (owned.rows.length !== new Set(ids).size) throw new CreativeCoreError(400, 'INVALID_JOB_ASSET', 'One or more creative assets are unavailable')
    }

    const id = `job_${randomUUID()}`
    const inserted = await client.query<JobRecord>(
      `INSERT INTO creative_jobs(id, owner_id, mode, status, model, prompt_original, parameters, idempotency_key)
       VALUES($1,$2,$3,'CREATED',$4,$5,$6::jsonb,$7)
       ON CONFLICT(owner_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [id, input.ownerId, input.mode, input.model, input.prompt, JSON.stringify(input.parameters), input.idempotencyKey]
    )
    if (!inserted.rows[0]) {
      const raced = await client.query<JobRecord>(
        'SELECT * FROM creative_jobs WHERE owner_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL',
        [input.ownerId, input.idempotencyKey]
      )
      if (!raced.rows[0]) throw new CreativeCoreError(409, 'CREATIVE_IDEMPOTENCY_CONFLICT', 'Creative job idempotency conflict')
      return raced.rows[0]
    }
    for (let index = 0; index < input.inputAssetIds.length; index += 1) {
      await client.query(
        `INSERT INTO creative_job_assets(job_id, asset_id, role, ordinal) VALUES($1,$2,'input',$3)`,
        [id, input.inputAssetIds[index], index]
      )
    }
    if (input.maskAssetId) {
      await client.query(`INSERT INTO creative_job_assets(job_id, asset_id, role, ordinal) VALUES($1,$2,'mask',0)`, [id, input.maskAssetId])
    }
    await appendEventWithClient(client, id, 'status', 'created', 'creative.activity.created', { mode: input.mode })
    return inserted.rows[0]
  })
}

export async function updateCreativeJobProviderCredential(jobId: string, input: {
  credentialId: string
  groupId: number
  rotationVersion: number
  retryCount: number
  rejectedRotationVersion: number
}) {
  const result = await creativeQuery<JobRecord>(
    `UPDATE creative_jobs
        SET parameters = parameters || jsonb_build_object(
              'provider_credential_id', $2::text,
              'provider_group_id', $3::bigint,
              'provider_credential_rotation', $4::integer,
              'provider_credential_retry_count', $5::integer,
              'provider_credential_rejected_rotation', $6::integer
            ),
            updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [jobId, input.credentialId, input.groupId, input.rotationVersion, input.retryCount, input.rejectedRotationVersion]
  )
  if (!result.rows[0]) throw new CreativeCoreError(404, 'CREATIVE_JOB_NOT_FOUND', 'Creative job was not found')
  return result.rows[0]
}

async function appendEventWithClient(client: PoolClient, jobId: string, type: string, phase: string, messageKey: string, payload: Json = {}) {
  const result = await client.query<CreativeEvent>(
    `INSERT INTO creative_job_events(job_id, type, phase, message_key, payload)
     VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id, job_id, type, phase, message_key, payload, created_at`,
    [jobId, type, phase, messageKey, JSON.stringify(payload)]
  )
  return result.rows[0]
}

export function appendCreativeEvent(jobId: string, type: string, phase: string, messageKey: string, payload: Json = {}) {
  return creativeTransaction((client) => appendEventWithClient(client, jobId, type, phase, messageKey, payload))
}

export async function getJobForOwner(ownerId: string, jobId: string) {
  const result = await creativeQuery<JobRecord>(
    `SELECT * FROM creative_jobs WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [jobId, ownerId]
  )
  if (!result.rows[0]) throw new CreativeCoreError(404, 'CREATIVE_JOB_NOT_FOUND', 'Creative job was not found')
  return result.rows[0]
}

export async function findJobForOwner(ownerId: string, jobId: string) {
  const result = await creativeQuery<JobRecord>(
    `SELECT * FROM creative_jobs WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [jobId, ownerId]
  )
  return result.rows[0] ?? null
}

export async function getJobInternal(jobId: string) {
  const result = await creativeQuery<JobRecord>('SELECT * FROM creative_jobs WHERE id = $1 AND deleted_at IS NULL', [jobId])
  if (!result.rows[0]) throw new CreativeCoreError(404, 'CREATIVE_JOB_NOT_FOUND', 'Creative job was not found')
  return result.rows[0]
}

export async function jobAssets(jobId: string, role?: 'input' | 'mask' | 'output' | 'thumbnail') {
  const result = await creativeQuery<AssetRecord & { role: string; ordinal: number }>(
    `SELECT a.*, ja.role, ja.ordinal
       FROM creative_job_assets ja
       JOIN creative_assets a ON a.id = ja.asset_id
      WHERE ja.job_id = $1 AND ($2::text IS NULL OR ja.role = $2) AND a.deleted_at IS NULL
      ORDER BY ja.role, ja.ordinal`,
    [jobId, role ?? null]
  )
  return result.rows
}

export async function listCreativeEvents(ownerId: string, jobId: string, after = 0) {
  await getJobForOwner(ownerId, jobId)
  const result = await creativeQuery<CreativeEvent>(
    `SELECT id, job_id, type, phase, message_key, payload, created_at
       FROM creative_job_events WHERE job_id = $1 AND id > $2 ORDER BY id ASC LIMIT 200`,
    [jobId, after]
  )
  return result.rows
}

export async function claimCreativeJobs(workerId: string, limit: number) {
  return creativeTransaction(async (client) => {
    const result = await client.query<JobRecord>(
      `WITH claimable AS (
         SELECT id
           FROM creative_jobs
          WHERE deleted_at IS NULL
            AND next_run_at <= now()
            AND status IN ('CREATED','ANALYZING','READY','QUEUED','RUNNING','VALIDATING','CANCEL_REQUESTED')
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE creative_jobs j
          SET lease_owner = $1, lease_expires_at = now() + interval '90 seconds', updated_at = now()
         FROM claimable
        WHERE j.id = claimable.id
       RETURNING j.*`,
      [workerId, limit]
    )
    return result.rows
  })
}

export async function renewCreativeJobLease(jobId: string, workerId: string) {
  const result = await creativeQuery<{ lease_expires_at: Date }>(
    `UPDATE creative_jobs
        SET lease_expires_at = now() + interval '90 seconds', updated_at = now()
      WHERE id = $1
        AND lease_owner = $2
        AND status IN ('CREATED','ANALYZING','READY','QUEUED','RUNNING','VALIDATING')
        AND deleted_at IS NULL
      RETURNING lease_expires_at`,
    [jobId, workerId]
  )
  return result.rows[0]?.lease_expires_at ?? null
}

export async function transitionCreativeJob(jobId: string, input: {
  status: CreativeJobStatus
  messageKey?: string
  phase?: string
  eventPayload?: Json
  plan?: CreativePlan | null
  compiledPrompt?: string | null
  providerTaskId?: string | null
  providerRequestId?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  nextRunAt?: Date
  attemptDelta?: number
  pollDelta?: number
  resultCount?: number
  completed?: boolean
  releaseLease?: boolean
}) {
  return creativeTransaction(async (client) => {
    const result = await client.query<JobRecord>(
      `UPDATE creative_jobs
          SET status = $2,
              plan = COALESCE($3::jsonb, plan),
              prompt_compiled = COALESCE($4, prompt_compiled),
              provider_task_id = COALESCE($5, provider_task_id),
              provider_request_id = COALESCE($6, provider_request_id),
              error_code = $7,
              error_message = $8,
              next_run_at = COALESCE($9, next_run_at),
              attempt_count = attempt_count + $10,
              poll_count = poll_count + $11,
              result_count = COALESCE($12, result_count),
              completed_at = CASE WHEN $13 THEN now() ELSE completed_at END,
              lease_owner = CASE WHEN $14 THEN NULL ELSE lease_owner END,
              lease_expires_at = CASE WHEN $14 THEN NULL ELSE lease_expires_at END,
              updated_at = now()
       WHERE id = $1
          AND status NOT IN ('COMPLETED','PARTIAL_SUCCESS','CANCELLED','FAILED','EXPIRED')
          AND NOT (status = 'CANCEL_REQUESTED' AND $2 <> 'CANCELLED')
        RETURNING *`,
      [jobId, input.status, input.plan ? JSON.stringify(input.plan) : null, input.compiledPrompt ?? null, input.providerTaskId ?? null, input.providerRequestId ?? null, input.errorCode ?? null, input.errorMessage ?? null, input.nextRunAt ?? null, input.attemptDelta ?? 0, input.pollDelta ?? 0, input.resultCount ?? null, input.completed ?? false, input.releaseLease ?? true]
    )
    if (!result.rows[0]) {
      const current = await client.query<{ status: CreativeJobStatus }>('SELECT status FROM creative_jobs WHERE id = $1', [jobId])
      if (current.rows[0]?.status === 'CANCEL_REQUESTED') {
        throw new CreativeCoreError(409, 'CREATIVE_CANCELLATION_PENDING', 'Creative job cancellation is pending')
      }
      if (current.rows[0] && ['COMPLETED','PARTIAL_SUCCESS','CANCELLED','FAILED','EXPIRED'].includes(current.rows[0].status)) {
        throw new CreativeCoreError(409, 'CREATIVE_JOB_TERMINAL', 'Creative job is already in a terminal state')
      }
      throw new CreativeCoreError(404, 'CREATIVE_JOB_NOT_FOUND', 'Creative job was not found')
    }
    if (input.messageKey) await appendEventWithClient(client, jobId, 'status', input.phase ?? input.status.toLowerCase(), input.messageKey, input.eventPayload)
    return result.rows[0]
  })
}

export async function attachJobAsset(jobId: string, assetId: string, role: 'output' | 'thumbnail', ordinal: number) {
  await creativeQuery(
    `INSERT INTO creative_job_assets(job_id, asset_id, role, ordinal)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(job_id, role, ordinal) DO UPDATE SET asset_id = EXCLUDED.asset_id`,
    [jobId, assetId, role, ordinal]
  )
}

export async function createCreativeVersion(input: { ownerId: string; jobId: string; resultAssetId: string; prompt: string; parentJobId?: string | null }) {
  let parentVersionId: string | null = null
  if (input.parentJobId) {
    const parent = await creativeQuery<{ id: string }>(
      `SELECT id FROM creative_versions WHERE owner_id = $1 AND job_id = $2`,
      [input.ownerId, input.parentJobId]
    )
    parentVersionId = parent.rows[0]?.id ?? null
  }
  const id = `ver_${randomUUID()}`
  const result = await creativeQuery<{ id: string }>(
    `INSERT INTO creative_versions(id, owner_id, job_id, parent_version_id, result_asset_id, prompt)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(job_id) DO UPDATE SET job_id = EXCLUDED.job_id
     RETURNING id`,
    [id, input.ownerId, input.jobId, parentVersionId, input.resultAssetId, input.prompt]
  )
  return result.rows[0].id
}

export async function listCreativeJobs(ownerId: string, input: { type?: 'image'; active?: boolean; page?: number; pageSize?: number } = {}) {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 24))
  const activeStatuses = ['CREATED','ANALYZING','READY','QUEUED','RUNNING','VALIDATING','CANCEL_REQUESTED']
  const values: unknown[] = [ownerId, pageSize, (page - 1) * pageSize]
  const activeClause = input.active ? `AND j.status = ANY($4::text[])` : ''
  if (input.active) values.push(activeStatuses)
  const result = await creativeQuery<JobRecord & { result_url: string | null; total_count: string }>(
    `SELECT j.*,
            '/api/v1/creative/assets/' || output.asset_id AS result_url,
            count(*) OVER()::text AS total_count
       FROM creative_jobs j
       LEFT JOIN LATERAL (
         SELECT asset_id FROM creative_job_assets WHERE job_id = j.id AND role = 'output' ORDER BY ordinal LIMIT 1
       ) output ON true
      WHERE j.owner_id = $1
        AND j.deleted_at IS NULL
        ${activeClause}
      ORDER BY j.created_at DESC LIMIT $2 OFFSET $3`,
    values
  )
  return { rows: result.rows, total: Number(result.rows[0]?.total_count ?? 0), page, pageSize }
}

export async function softDeleteCreativeJob(ownerId: string, jobId: string) {
  const result = await creativeQuery(
    `UPDATE creative_jobs SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
        AND status IN ('COMPLETED','PARTIAL_SUCCESS','CANCELLED','FAILED','EXPIRED')`,
    [jobId, ownerId]
  )
  if (!result.rowCount) {
    const existing = await creativeQuery<{ status: CreativeJobStatus }>(
      'SELECT status FROM creative_jobs WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
      [jobId, ownerId]
    )
    if (existing.rows[0]) throw new CreativeCoreError(409, 'CREATIVE_JOB_ACTIVE', 'Cancel the active creative job before deleting it')
    throw new CreativeCoreError(404, 'CREATIVE_JOB_NOT_FOUND', 'Creative job was not found')
  }
}

export async function requestCreativeCancellation(ownerId: string, jobId: string) {
  return creativeTransaction(async (client) => {
    const selected = await client.query<JobRecord>(
      `SELECT * FROM creative_jobs
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [jobId, ownerId]
    )
    const current = selected.rows[0]
    if (!current) throw new CreativeCoreError(404, 'CREATIVE_JOB_NOT_FOUND', 'Creative job was not found')
    if (current.status === 'CANCELLED') return current
    const cancellable = ['CREATED','ANALYZING','READY','QUEUED','RUNNING','VALIDATING','CANCEL_REQUESTED']
    if (!cancellable.includes(current.status)) throw new CreativeCoreError(409, 'CREATIVE_JOB_NOT_CANCELLABLE', 'Creative job cannot be cancelled')

    if (current.status !== 'CANCEL_REQUESTED') {
      await appendEventWithClient(client, jobId, 'status', 'cancelling', 'creative.activity.cancelling')
    }
    const result = await client.query<JobRecord>(
      `UPDATE creative_jobs
          SET status = 'CANCELLED',
              completed_at = COALESCE(completed_at, now()),
              next_run_at = now(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [jobId]
    )
    await appendEventWithClient(client, jobId, 'status', 'cancelled', 'creative.activity.cancelled', {
      provider_may_continue: Boolean(current.provider_task_id || current.lease_owner),
    })
    return result.rows[0]
  })
}

export async function resultUrlsForJob(jobId: string) {
  const assets = await jobAssets(jobId, 'output')
  return assets.map((asset) => `/api/v1/creative/assets/${asset.id}`)
}

export async function creativeJobDto(job: JobRecord): Promise<CreativeJob> {
  const resultUrls = await resultUrlsForJob(job.id)
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    model: job.model,
    prompt: job.prompt_original,
    compiled_prompt: job.prompt_compiled,
    plan: job.plan,
    parameters: job.parameters,
    provider_task_id: job.provider_task_id,
    result_url: resultUrls[0] ?? null,
    result_urls: resultUrls,
    error_code: job.error_code,
    error_message: job.error_message,
    attempt_count: job.attempt_count,
    created_at: iso(job.created_at)!,
    updated_at: iso(job.updated_at)!,
    completed_at: iso(job.completed_at),
  }
}
