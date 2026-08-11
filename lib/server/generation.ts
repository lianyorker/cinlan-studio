import { getStudioSession, type StudioSession } from './session'
import { refreshStudioSession } from './studio-auth'
import { Sub2ApiError, sub2apiFetch } from './sub2api'
import { CreativeCoreError } from './creative/errors'
import { withStudioCredential } from './creative/provider-credentials'
import { manualApiKeyLoginEnabled } from './studio-config'

export async function requireGenerationSession() {
  const session = await getStudioSession()
  if (!session) throw new Sub2ApiError(401, '请先登录或连接 Sub2API Key', 'AUTH_REQUIRED')
  if (session.authMode === 'api_key' && !manualApiKeyLoginEnabled()) {
    throw new Sub2ApiError(401, 'Sub2API account login is required', 'AUTH_REQUIRED')
  }
  return session.authMode === 'login' ? refreshStudioSession(session) : session
}

export function canonicalBody(input: Record<string, unknown>) {
  const body: Record<string, unknown> = { ...input }
  if (body.aspectRatio && !body.aspect_ratio) body.aspect_ratio = body.aspectRatio
  if (body.generateAudio !== undefined && body.audio === undefined) body.audio = body.generateAudio
  if (body.count !== undefined && body.n === undefined) body.n = body.count
  delete body.aspectRatio
  delete body.resolution
  delete body.duration
  delete body.quality
  delete body.count
  return body
}

export function normalizedStatus(value: unknown) {
  const status = String(value ?? '').toLowerCase()
  if (['completed', 'succeeded', 'success', 'done'].includes(status)) return 'COMPLETED'
  if (['partial_success', 'partially_completed', 'partial'].includes(status)) return 'PARTIAL_SUCCESS'
  if (['cancelled', 'canceled'].includes(status)) return 'CANCELLED'
  if (['expired', 'timed_out'].includes(status)) return 'EXPIRED'
  if (['failed', 'error'].includes(status)) return 'FAILED'
  if (['pending', 'created'].includes(status)) return 'PENDING'
  if (['queued', 'in_queue'].includes(status)) return 'IN_QUEUE'
  return 'IN_PROGRESS'
}

export function resultUrl(payload: unknown): string | undefined {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = resultUrl(item)
      if (nested) return nested
    }
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.b64_json === 'string' && value.b64_json) return `data:image/png;base64,${value.b64_json}`
  const direct = ['image_url', 'video_url', 'download_url', 'content_url', 'url', 'result_url']
  for (const key of direct) if (typeof value[key] === 'string' && value[key]) return value[key] as string
  const result = value.result
  if (result && typeof result === 'object') {
    const nested = resultUrl(result)
    if (nested) return nested
  }
  const data = value.data
  if (Array.isArray(data)) {
    for (const item of data) {
      const nested = resultUrl(item)
      if (nested) return nested
    }
  }
  const video = value.video
  if (video && typeof video === 'object') return resultUrl(video)
  return undefined
}

export function resultUrls(payload: unknown): string[] {
  const urls: string[] = []
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (typeof object.b64_json === 'string' && object.b64_json) urls.push(`data:image/png;base64,${object.b64_json}`)
    for (const key of ['image_url', 'video_url', 'download_url', 'content_url', 'url', 'result_url']) {
      if (typeof object[key] === 'string' && object[key]) urls.push(object[key] as string)
    }
    for (const key of ['result', 'data', 'video']) visit(object[key])
  }
  visit(payload)
  return [...new Set(urls)]
}

export function resultError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.error === 'string' && value.error) return value.error
  if (value.error && typeof value.error === 'object') {
    const error = value.error as Record<string, unknown>
    if (typeof error.message === 'string' && error.message) return error.message
    if (typeof error.code === 'string' && error.code) return error.code
  }
  if (typeof value.message === 'string' && value.message) return value.message
  return undefined
}

function nestedValue(payload: unknown, keys: string[]): unknown {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = nestedValue(item, keys)
      if (value !== undefined && value !== null && value !== '') return value
    }
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Record<string, unknown>
  for (const key of keys) if (value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key]
  for (const key of ['result', 'video', 'data']) {
    const nested = nestedValue(value[key], keys)
    if (nested !== undefined && nested !== null && nested !== '') return nested
  }
  return undefined
}

export function mediaTaskDetails(payload: unknown, id: string, type: 'image' | 'video') {
  const status = normalizedStatus(nestedValue(payload, ['status']))
  const durationMs = Number(nestedValue(payload, ['duration_ms']))
  const durationValue = Number(nestedValue(payload, ['duration', 'duration_seconds']))
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : durationValue
  const createdValue = nestedValue(payload, ['created_at', 'createdAt'])
  const completedValue = nestedValue(payload, ['completed_at', 'completedAt'])
  const expiresValue = nestedValue(payload, ['expires_at', 'expiresAt'])
  return {
    id,
    task_id: id,
    type,
    model: nestedValue(payload, ['model']),
    status,
    result_url: resultUrl(payload),
    result_urls: resultUrls(payload),
    thumbnail_url: typeof nestedValue(payload, ['thumbnail_url', 'thumbnail']) === 'string' ? nestedValue(payload, ['thumbnail_url', 'thumbnail']) : undefined,
    cover_url: typeof nestedValue(payload, ['cover_url', 'cover', 'poster_url', 'poster']) === 'string' ? nestedValue(payload, ['cover_url', 'cover', 'poster_url', 'poster']) : undefined,
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    created_at: createdValue,
    completed_at: completedValue,
    expires_at: expiresValue,
    poll_url: typeof nestedValue(payload, ['poll_url']) === 'string' ? nestedValue(payload, ['poll_url']) : undefined,
    credits_used: Number(nestedValue(payload, ['credits_used', 'credits'])) || 0,
    error: resultError(payload),
  }
}

export async function getImageTask(id: string, apiKey: string, signal?: AbortSignal) {
  const image = await sub2apiFetch<unknown>(`/v1/images/tasks/${encodeURIComponent(id)}`, { apiKey, signal })
  return mediaTaskDetails(image, id, 'image')
}

export async function getVideoTask(id: string, apiKey: string, signal?: AbortSignal) {
  const video = await sub2apiFetch<unknown>(`/v1/videos/${encodeURIComponent(id)}`, { apiKey, signal })
  return mediaTaskDetails(video, id, 'video')
}

export async function getTask(id: string, session: StudioSession | string | undefined, signal?: AbortSignal) {
  if (typeof session !== 'object') {
    if (!session) throw new Sub2ApiError(401, 'Please sign in to Cinlan Studio', 'AUTH_REQUIRED')
    try {
      return await getImageTask(id, session, signal)
    } catch (error) {
      if (!(error instanceof Sub2ApiError) || error.status !== 404) throw error
    }
    return getVideoTask(id, session, signal)
  }
  try {
    return await withStudioCredential(session, 'image', undefined, async (credential) => {
      return getImageTask(id, credential.apiKey, signal)
    })
  } catch (error) {
    const unavailableImageCapability = error instanceof CreativeCoreError
      && ['STUDIO_FEATURE_NOT_CONFIGURED', 'STUDIO_GROUP_NOT_FOUND'].includes(error.code)
    if (!unavailableImageCapability && (!(error instanceof Sub2ApiError) || error.status !== 404)) throw error
  }
  return withStudioCredential(session, 'video', undefined, async (credential) => {
    return getVideoTask(id, credential.apiKey, signal)
  })
}
