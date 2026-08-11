import { randomUUID } from 'node:crypto'
import type { CreativeAnalysisMode, CreativeJobStatus } from '@/lib/creative-types'
import { getImageTask } from '../generation'
import { Sub2ApiError } from '../sub2api'
import { creativeAssetBytes, storeCreativeResult } from './assets'
import { removeBackgroundWithAliyun } from './aliyun-background-removal'
import {
  consumeBackgroundRemovalUsage,
  recordBackgroundRemovalProviderRequest,
  releaseBackgroundRemovalUsage,
  restoreBackgroundRemovalReservation,
} from './background-removal-quota'
import { CreativeCoreError } from './errors'
import { openCreativeCredential } from './identity'
import { compileCreativePrompt, createCreativePlan } from './planner'
import { requestProviderImage, type ProviderReference } from './provider'
import { resolveModelCapabilities } from './capabilities'
import { creativeInProcessWorkerEnabled } from './config'
import {
  attachJobAsset,
  claimCreativeJobs,
  createCreativeVersion,
  creativeCredential,
  getJobInternal,
  jobAssets,
  renewCreativeJobLease,
  transitionCreativeJob,
  updateCreativeJobProviderCredential,
  type JobRecord,
} from './repository'
import {
  providerCredentialRejected,
  rotateStoredStudioCredential,
  storedStudioCredential,
  type StudioProviderCredential,
} from './provider-credentials'

declare global {
  // eslint-disable-next-line no-var
  var __cinlanCreativeDrain: Promise<void> | undefined
  // eslint-disable-next-line no-var
  var __cinlanCreativeControllers: Map<string, AbortController> | undefined
}

const MAX_PROVIDER_POLLS = 240

function noCompatibleAccounts(error: unknown) {
  return error instanceof Sub2ApiError
    && /no available compatible accounts|no available OpenAI accounts supporting model|pool=0/i.test(error.message)
}

function creativeControllers() {
  globalThis.__cinlanCreativeControllers ??= new Map()
  return globalThis.__cinlanCreativeControllers
}

export function abortInProcessCreativeJob(jobId: string) {
  return creativeControllers().get(jobId)?.abort()
}

function retryable(error: unknown) {
  if (noCompatibleAccounts(error)) return false
  if (error instanceof Sub2ApiError) return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
  return error instanceof TypeError || (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

function errorDetails(error: unknown) {
  if (noCompatibleAccounts(error)) return { code: 'NO_COMPATIBLE_ACCOUNTS', message: error instanceof Error ? error.message : 'No available compatible accounts' }
  if (error instanceof Sub2ApiError) return { code: error.code || `UPSTREAM_HTTP_${error.status}`, message: error.message }
  if (error instanceof CreativeCoreError) return { code: error.code, message: error.message }
  return { code: 'CREATIVE_JOB_FAILED', message: error instanceof Error ? error.message : 'Creative job failed' }
}

async function providerReferences(jobId: string) {
  const assets = await jobAssets(jobId)
  const references: ProviderReference[] = []
  for (const asset of assets) {
    if (asset.role !== 'input' && asset.role !== 'mask') continue
    references.push({
      bytes: await creativeAssetBytes(asset),
      mime: asset.mime_type,
      filename: asset.original_name || `${asset.id}.png`,
      role: asset.role as 'input' | 'mask',
    })
  }
  return references
}

function analysisMode(job: JobRecord): CreativeAnalysisMode {
  return job.parameters.analysis_mode === 'standard' ? 'standard' : 'deep'
}

function requestedOutputCount(job: JobRecord) {
  return Math.min(4, Math.max(1, Number(job.parameters.count || 1)))
}

function isBackgroundRemovalJob(job: JobRecord) {
  return job.parameters.operation === 'background_removal' && job.model === 'aliyun-segment-common-image'
}

function backgroundRemovalRetryable(error: unknown) {
  if (error instanceof TypeError || (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'))) return true
  if (!(error instanceof CreativeCoreError)) return false
  if (/NOT_CONFIGURED|INPUT_TOO_LARGE|SOURCE_MISSING|InvalidAccessKey|Forbidden|Unauthorized/i.test(error.code)) return false
  return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
}

async function finishCancellation(jobId: string, providerMayContinue = false) {
  const current = await getJobInternal(jobId)
  if (current.status === 'CANCELLED') return true
  if (current.status !== 'CANCEL_REQUESTED') return false
  await transitionCreativeJob(jobId, {
    status: 'CANCELLED',
    messageKey: 'creative.activity.cancelled',
    phase: 'cancelled',
    eventPayload: { provider_may_continue: providerMayContinue || Boolean(current.provider_task_id) },
    completed: true,
  })
  return true
}

async function processBackgroundRemovalJob(job: JobRecord) {
  const existing = await jobAssets(job.id, 'output')
  if (existing[0]) {
    await transitionCreativeJob(job.id, {
      status: 'COMPLETED',
      phase: 'completed',
      messageKey: 'creative.activity.background_removal_completed',
      resultCount: 1,
      completed: true,
    })
    return
  }
  const source = (await jobAssets(job.id, 'input'))[0]
  if (!source) throw new CreativeCoreError(400, 'BACKGROUND_REMOVAL_SOURCE_MISSING', 'Background-removal source asset is missing')
  await transitionCreativeJob(job.id, {
    status: 'RUNNING',
    phase: 'background_removal',
    messageKey: 'creative.activity.background_removing',
    attemptDelta: 1,
    releaseLease: false,
  })
  let providerStarted = false
  let result: Awaited<ReturnType<typeof removeBackgroundWithAliyun>>
  try {
    result = await removeBackgroundWithAliyun(await creativeAssetBytes(source), async () => {
      providerStarted = await consumeBackgroundRemovalUsage(job.id)
    })
  } catch (error) {
    if (await finishCancellation(job.id, providerStarted).catch(() => false)) {
      if (!providerStarted) await releaseBackgroundRemovalUsage(job.id)
      return
    }
    const details = errorDetails(error)
    const current = await getJobInternal(job.id)
    if (backgroundRemovalRetryable(error) && current.attempt_count < current.max_attempts) {
      await restoreBackgroundRemovalReservation(job.id)
      const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, current.attempt_count - 1))
      await transitionCreativeJob(job.id, {
        status: 'QUEUED',
        phase: 'retrying',
        messageKey: 'creative.activity.retrying',
        eventPayload: { attempt: current.attempt_count + 1, code: details.code },
        errorCode: details.code,
        errorMessage: details.message,
        nextRunAt: new Date(Date.now() + delay),
      })
      return
    }
    await releaseBackgroundRemovalUsage(job.id)
    await transitionCreativeJob(job.id, {
      status: 'FAILED',
      phase: 'failed',
      messageKey: 'creative.activity.background_removal_failed',
      eventPayload: { code: details.code },
      errorCode: details.code,
      errorMessage: details.message,
      completed: true,
    })
    return
  }
  try {
    await recordBackgroundRemovalProviderRequest(job.id, result.requestId || 'accepted')
    if (await finishCancellation(job.id, true)) return
    await transitionCreativeJob(job.id, {
      status: 'VALIDATING',
      phase: 'validating',
      messageKey: 'creative.activity.validating',
      providerRequestId: result.requestId || null,
      releaseLease: false,
    })
    const asset = await storeCreativeResult(job.owner_id, result.imageUrl, 0)
    await attachJobAsset(job.id, asset.id, 'output', 0)
    await createCreativeVersion({
      ownerId: job.owner_id,
      jobId: job.id,
      resultAssetId: asset.id,
      prompt: job.prompt_original,
    })
    await transitionCreativeJob(job.id, {
      status: 'COMPLETED',
      phase: 'completed',
      messageKey: 'creative.activity.background_removal_completed',
      resultCount: 1,
      completed: true,
    })
  } catch (error) {
    if (await finishCancellation(job.id, true).catch(() => false)) return
    const details = errorDetails(error)
    await transitionCreativeJob(job.id, {
      status: 'FAILED',
      phase: 'failed',
      messageKey: 'creative.activity.background_removal_failed',
      eventPayload: { code: details.code },
      errorCode: details.code,
      errorMessage: details.message,
      completed: true,
    }).catch(() => {})
  }
}

async function finalizeResults(job: JobRecord, outputAssets: Awaited<ReturnType<typeof jobAssets>>, recovered = false) {
  const resolution = String(job.parameters.resolution || '').toUpperCase()
  const minimumEdge = resolution === '4K' ? 3840 : resolution === '2K' ? 2048 : resolution === '1K' ? 1024 : 0
  const undersized = minimumEdge > 0 && outputAssets.some((asset) => Math.max(asset.width || 0, asset.height || 0) > 0 && Math.max(asset.width || 0, asset.height || 0) < minimumEdge)
  const count = Math.min(4, Math.max(1, Number(job.parameters.count || 1)))
  const partial = outputAssets.length < count || undersized

  await createCreativeVersion({
    ownerId: job.owner_id,
    jobId: job.id,
    resultAssetId: outputAssets[0].id,
    prompt: job.prompt_original,
    parentJobId: typeof job.parameters.parent_job_id === 'string' ? job.parameters.parent_job_id : null,
  })
  await transitionCreativeJob(job.id, {
    status: partial ? 'PARTIAL_SUCCESS' : 'COMPLETED',
    phase: partial ? 'partial' : 'completed',
    messageKey: partial ? 'creative.activity.partial' : 'creative.activity.completed',
    eventPayload: { result_count: outputAssets.length, requested_count: count, resolution_warning: undersized, ...(recovered ? { recovered: true } : {}) },
    resultCount: outputAssets.length,
    completed: true,
  })
}

async function persistResults(job: JobRecord, urls: string[], expectedCount: number) {
  if (!urls.length) throw new CreativeCoreError(502, 'EMPTY_PROVIDER_RESULT', 'Image provider completed without an image')
  const existing = await jobAssets(job.id, 'output')
  const remaining = Math.max(0, expectedCount - existing.length)
  for (let index = 0; index < Math.min(remaining, urls.length); index += 1) {
    const ordinal = existing.length + index
    const asset = await storeCreativeResult(job.owner_id, urls[index], ordinal)
    await attachJobAsset(job.id, asset.id, 'output', ordinal)
  }
  const outputs = await jobAssets(job.id, 'output')
  if (outputs.length >= expectedCount) {
    await finalizeResults(job, outputs)
    return
  }
  await transitionCreativeJob(job.id, {
    status: 'QUEUED',
    messageKey: 'creative.activity.queued',
    phase: 'queued',
    eventPayload: { result_count: outputs.length, requested_count: expectedCount },
    nextRunAt: new Date(),
  })
}

async function resumeValidation(job: JobRecord, apiKey: string, signal: AbortSignal) {
  const outputs = await jobAssets(job.id, 'output')
  const expected = requestedOutputCount(job)
  if (outputs.length >= expected) {
    await finalizeResults(job, outputs, true)
    return
  }
  if (job.provider_task_id) {
    await pollJob({ ...job, status: 'RUNNING' }, apiKey, signal)
    return
  }
  await submitJob(job, apiKey, signal)
}

async function submitJob(job: JobRecord, apiKey: string, signal: AbortSignal) {
  const references = await providerReferences(job.id)
  const inputReferences = references.filter((reference) => reference.role === 'input')
  const capability = await resolveModelCapabilities(job.model, 'image')
  if (!capability?.text_to_image) throw new CreativeCoreError(400, 'MODEL_IMAGE_UNSUPPORTED', 'Selected model does not support image generation')
  if (inputReferences.length && !capability.image_edit) throw new CreativeCoreError(400, 'MODEL_EDIT_UNSUPPORTED', 'Selected model does not support image editing')
  if (inputReferences.length > capability.max_reference_images) throw new CreativeCoreError(400, 'TOO_MANY_REFERENCE_IMAGES', 'Selected model does not support this many reference images')
  if (references.some((reference) => reference.role === 'mask') && !capability.mask) throw new CreativeCoreError(400, 'MODEL_MASK_UNSUPPORTED', 'Selected model does not support mask editing')

  let compiledPrompt = job.prompt_compiled
  if (!job.plan || !compiledPrompt) {
    await transitionCreativeJob(job.id, {
      status: 'ANALYZING',
      messageKey: 'creative.activity.analyzing',
      phase: 'analyzing',
      eventPayload: { reference_count: inputReferences.length },
      attemptDelta: 1,
      releaseLease: false,
    })
    const plan = await createCreativePlan({ apiKey, prompt: job.prompt_original, references, analysisMode: analysisMode(job), signal })
    if (await finishCancellation(job.id)) return
    compiledPrompt = compileCreativePrompt(
      job.prompt_original,
      plan,
      inputReferences.length,
      String(job.parameters.aspect_ratio || '') || undefined,
      String(job.parameters.background || '').toLowerCase() === 'transparent'
    )
    await transitionCreativeJob(job.id, {
      status: 'READY',
      messageKey: 'creative.activity.planned',
      phase: 'planned',
      eventPayload: {
        planner: plan.planner,
        must_preserve: plan.must_preserve.slice(0, 4),
        composition: plan.composition,
      },
      plan,
      compiledPrompt,
      releaseLease: false,
    })
    await transitionCreativeJob(job.id, {
      status: 'QUEUED',
      messageKey: 'creative.activity.queued',
      phase: 'queued',
      releaseLease: false,
    })
  } else {
    await transitionCreativeJob(job.id, { status: 'QUEUED', attemptDelta: 1, releaseLease: false })
  }
  if (await finishCancellation(job.id)) return

  const count = Math.min(capability.max_outputs, requestedOutputCount(job))
  const outputAssets = await jobAssets(job.id, 'output')
  if (outputAssets.length >= count) {
    await finalizeResults(await getJobInternal(job.id), outputAssets, true)
    return
  }
  const outputIndex = outputAssets.length
  const providerPrompt = count > 1
    ? `${compiledPrompt}\n\nOutput ${outputIndex + 1} of ${count}: create a distinct visual variation while keeping the same brief and output constraints.`
    : compiledPrompt
  // Responses-backed image tools reject `n`; persist one output per worker step so a 4-image job remains resumable.
  const result = await requestProviderImage({
    apiKey,
    model: job.model,
    prompt: providerPrompt,
    count: 1,
    parameters: job.parameters,
    references,
    idempotencyKey: count > 1 ? `${job.idempotency_key}-${outputIndex + 1}` : job.idempotency_key,
    compiled: true,
    signal,
  })
  if (await finishCancellation(job.id, true)) return
  if (result.status === 'COMPLETED') {
    await transitionCreativeJob(job.id, {
      status: 'QUEUED',
      messageKey: 'creative.activity.validating',
      phase: 'validating',
      providerRequestId: result.id,
      releaseLease: false,
    })
    await persistResults(await getJobInternal(job.id), result.result_urls, count)
    return
  }

  await transitionCreativeJob(job.id, {
    status: 'RUNNING',
    messageKey: 'creative.activity.generating',
    phase: 'generating',
    providerTaskId: result.id,
    nextRunAt: new Date(Date.now() + 2500),
  })
}

async function pollJob(job: JobRecord, apiKey: string, signal: AbortSignal) {
  if (!job.provider_task_id) throw new CreativeCoreError(502, 'PROVIDER_TASK_MISSING', 'Creative job has no provider task ID')
  const task = await getImageTask(job.provider_task_id, apiKey, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
  const expectedCount = requestedOutputCount(job)
  if (await finishCancellation(job.id, true)) return
  if (task.status === 'IN_PROGRESS' || task.status === 'PENDING' || task.status === 'IN_QUEUE') {
    if (job.poll_count + 1 >= MAX_PROVIDER_POLLS * expectedCount) {
      await transitionCreativeJob(job.id, {
        status: 'EXPIRED',
        messageKey: 'creative.activity.expired',
        phase: 'expired',
        errorCode: 'CREATIVE_JOB_EXPIRED',
        errorMessage: 'Image provider did not complete before the polling limit',
        pollDelta: 1,
        completed: true,
      })
      return
    }
    await transitionCreativeJob(job.id, {
      status: 'RUNNING',
      nextRunAt: new Date(Date.now() + 2500),
      pollDelta: 1,
    })
    return
  }
  if (task.status === 'CANCELLED') {
    await transitionCreativeJob(job.id, { status: 'CANCELLED', messageKey: 'creative.activity.cancelled', phase: 'cancelled', completed: true })
    return
  }
  if (task.status === 'FAILED' || task.status === 'EXPIRED') {
    throw new CreativeCoreError(502, task.status === 'EXPIRED' ? 'PROVIDER_TASK_EXPIRED' : 'PROVIDER_TASK_FAILED', task.error || `Provider task ${task.status.toLowerCase()}`)
  }
  await transitionCreativeJob(job.id, {
    status: 'QUEUED',
    messageKey: 'creative.activity.validating',
    phase: 'validating',
    providerRequestId: job.provider_task_id,
    releaseLease: false,
  })
  await persistResults(
    await getJobInternal(job.id),
    task.result_urls?.length ? task.result_urls : task.result_url ? [task.result_url] : [],
    expectedCount
  )
}

async function workerCredential(job: JobRecord): Promise<StudioProviderCredential> {
  const credentialId = typeof job.parameters.provider_credential_id === 'string'
    ? job.parameters.provider_credential_id
    : ''
  if (credentialId) return storedStudioCredential(job.owner_id, credentialId)
  return {
    id: null,
    ownerId: job.owner_id,
    groupId: null,
    remoteKeyId: null,
    rotationVersion: 0,
    apiKey: openCreativeCredential(await creativeCredential(job.owner_id)),
    managed: false,
  }
}

async function requeueAfterCredentialRotation(job: JobRecord, credential: StudioProviderCredential, error: unknown) {
  if (!credential.managed || !credential.id || !credential.groupId || !providerCredentialRejected(error)) return false
  const current = await getJobInternal(job.id)
  const retryCount = Number(current.parameters.provider_credential_retry_count || 0)
  const rejectedRotation = Number(current.parameters.provider_credential_rejected_rotation || 0)
  if (rejectedRotation === credential.rotationVersion) return false
  const rotated = await rotateStoredStudioCredential(job.owner_id, credential)
  if (rotated.rotationVersion === credential.rotationVersion || !rotated.id || !rotated.groupId) return false
  await updateCreativeJobProviderCredential(job.id, {
    credentialId: rotated.id,
    groupId: rotated.groupId,
    rotationVersion: rotated.rotationVersion,
    retryCount: retryCount + 1,
    rejectedRotationVersion: credential.rotationVersion,
  })
  await transitionCreativeJob(job.id, {
    status: current.provider_task_id ? 'RUNNING' : 'QUEUED',
    phase: 'retrying',
    messageKey: 'creative.activity.retrying',
    eventPayload: { code: 'STUDIO_CREDENTIAL_ROTATED', rotation_version: rotated.rotationVersion },
    nextRunAt: new Date(),
  })
  return true
}

async function failOrRetry(job: JobRecord, error: unknown) {
  const details = errorDetails(error)
  const current = await getJobInternal(job.id)
  const expectedCount = requestedOutputCount(current)
  if (retryable(error) && current.status === 'RUNNING' && current.poll_count < MAX_PROVIDER_POLLS * expectedCount) {
    await transitionCreativeJob(job.id, {
      status: 'RUNNING',
      messageKey: 'creative.activity.poll_retrying',
      phase: 'generating',
      eventPayload: { poll: current.poll_count + 1 },
      nextRunAt: new Date(Date.now() + 5000),
      pollDelta: 1,
    })
    return
  }
  if (current.status === 'RUNNING' && current.poll_count >= MAX_PROVIDER_POLLS * expectedCount) {
    await transitionCreativeJob(job.id, {
      status: 'EXPIRED',
      messageKey: 'creative.activity.expired',
      phase: 'expired',
      errorCode: 'CREATIVE_JOB_EXPIRED',
      errorMessage: details.message,
      completed: true,
    })
    return
  }
  if (retryable(error) && current.attempt_count < current.max_attempts * expectedCount && current.status !== 'RUNNING') {
    const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, current.attempt_count - 1))
    await transitionCreativeJob(job.id, {
      status: 'QUEUED',
      messageKey: 'creative.activity.retrying',
      phase: 'retrying',
      eventPayload: { attempt: current.attempt_count + 1, code: details.code },
      errorCode: details.code,
      errorMessage: details.message,
      nextRunAt: new Date(Date.now() + delay),
    })
    return
  }
  const outputs = await jobAssets(current.id, 'output')
  if (outputs.length) {
    await finalizeResults(current, outputs)
    return
  }
  await transitionCreativeJob(job.id, {
    status: 'FAILED',
    messageKey: 'creative.activity.failed',
    phase: 'failed',
    eventPayload: { code: details.code },
    errorCode: details.code,
    errorMessage: details.message,
    completed: true,
  })
}

export async function processCreativeJob(job: JobRecord) {
  const controller = new AbortController()
  creativeControllers().set(job.id, controller)
  const heartbeat = job.lease_owner ? setInterval(() => {
    void renewCreativeJobLease(job.id, job.lease_owner!).catch((error) => {
      console.error('[creative-worker] lease heartbeat failed', { jobId: job.id, message: error instanceof Error ? error.message : String(error) })
    })
  }, 20_000) : undefined
  try {
    if (job.status === 'CANCEL_REQUESTED') {
      if (isBackgroundRemovalJob(job)) await releaseBackgroundRemovalUsage(job.id)
      await transitionCreativeJob(job.id, {
        status: 'CANCELLED',
        messageKey: 'creative.activity.cancelled',
        phase: 'cancelled',
        eventPayload: { provider_may_continue: Boolean(job.provider_task_id) },
        completed: true,
      })
      return
    }
    if (isBackgroundRemovalJob(job)) {
      await processBackgroundRemovalJob(job)
      return
    }
    const credential = await workerCredential(job)
    try {
      if (job.status === 'RUNNING') await pollJob(job, credential.apiKey, controller.signal)
      else if (job.status === 'VALIDATING') await resumeValidation(job, credential.apiKey, controller.signal)
      else await submitJob(job, credential.apiKey, controller.signal)
    } catch (error) {
      if (await requeueAfterCredentialRotation(job, credential, error)) return
      throw error
    }
  } catch (error) {
    if (await finishCancellation(job.id, Boolean(job.provider_task_id)).catch(() => false)) {
      if (isBackgroundRemovalJob(job)) await releaseBackgroundRemovalUsage(job.id)
      return
    }
    if (isBackgroundRemovalJob(job)) {
      const details = errorDetails(error)
      await releaseBackgroundRemovalUsage(job.id)
      await transitionCreativeJob(job.id, {
        status: 'FAILED',
        phase: 'failed',
        messageKey: 'creative.activity.background_removal_failed',
        eventPayload: { code: details.code },
        errorCode: details.code,
        errorMessage: details.message,
        completed: true,
      }).catch(() => {})
      return
    }
    await failOrRetry(job, error)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    if (creativeControllers().get(job.id) === controller) creativeControllers().delete(job.id)
  }
}

export async function runCreativeWorkerBatch(limit = 2, workerId = `worker_${randomUUID()}`) {
  const jobs = await claimCreativeJobs(workerId, limit)
  await Promise.all(jobs.map(processCreativeJob))
  return jobs.length
}

export function scheduleCreativeDrain() {
  if (!creativeInProcessWorkerEnabled()) return
  if (globalThis.__cinlanCreativeDrain) return
  let processed = 0
  globalThis.__cinlanCreativeDrain = new Promise((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      for (let index = 0; index < 8; index += 1) {
        const count = await runCreativeWorkerBatch(2, 'in_process')
        processed += count
        if (!count) break
      }
    })
    .catch((error) => console.error('[creative-worker] in-process drain failed', { message: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      globalThis.__cinlanCreativeDrain = undefined
      if (creativeInProcessWorkerEnabled()) setTimeout(scheduleCreativeDrain, processed > 0 ? 2600 : 5000)
    })
}
