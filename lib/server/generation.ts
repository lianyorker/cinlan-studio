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

const RESULT_CONTAINER_KEYS = ['events', 'result', 'results', 'data', 'images', 'image', 'artifacts', 'artifact', 'outputs', 'output', 'files', 'file', 'media', 'video', 'task', 'job', 'response', 'meta']
const RESULT_URL_KEYS = ['image_url', 'imageUrl', 'image_urls', 'imageUrls', 'video_url', 'videoUrl', 'video_urls', 'videoUrls', 'download_url', 'downloadUrl', 'content_url', 'contentUrl', 'result_url', 'resultUrl', 'result_urls', 'resultUrls', 'output_url', 'outputUrl', 'file_url', 'fileUrl', 'uri', 'url']
const RESULT_BASE64_KEYS = ['b64_json', 'b64Json', 'b64', 'base64', 'image_data', 'imageData', 'image_base64', 'imageBase64']
const TASK_ID_KEYS = ['task_id', 'taskId', 'taskID', 'request_id', 'requestId', 'requestID', 'job_id', 'jobId', 'jobID', 'operation_id', 'operationId', 'operationID', 'task', 'job']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function visitPayload(value: unknown, visit: (object: Record<string, unknown>, depth: number) => void, depth = 0, seen = new Set<object>()) {
  if (depth > 10 || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) visitPayload(item, visit, depth + 1, seen)
    return
  }
  if (!isRecord(value) || seen.has(value)) return
  seen.add(value)
  visit(value, depth)
  for (const key of RESULT_CONTAINER_KEYS) visitPayload(value[key], visit, depth + 1, seen)
}

function imageMimeType(value: Record<string, unknown>) {
  const mime = String(value.mime_type ?? value.mimeType ?? value.content_type ?? value.contentType ?? '').trim().toLowerCase()
  return mime.startsWith('image/') ? mime : 'image/png'
}

function base64Result(value: string, mime: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.startsWith('data:image/') ? trimmed : 'data:' + mime + ';base64,' + trimmed
}

export function resultUrl(payload: unknown): string | undefined {
  return resultUrls(payload)[0]
}

export function resultUrls(payload: unknown): string[] {
  const urls: string[] = []
  const seen = new Set<object>()
  const mediaUrl = /^(?:https?:|data:image\/|blob:|\/)/i
  const encodedImage = /^(?:iVBORw0KGgo|\/9j\/|UklGR|R0lGOD|PHN2Zy)/
  function visit(value: unknown, context = false, key = '', mime = 'image/png', depth = 0) {
    if (depth > 12 || value === null || value === undefined) return
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) return
      if (RESULT_BASE64_KEYS.some((candidate) => candidate.toLowerCase() === key.toLowerCase())
        || (context && ['result', 'image', 'output', 'data', 'content'].includes(key.toLowerCase()) && encodedImage.test(text))) {
        const result = base64Result(text, mime)
        if (result) urls.push(result)
      } else if ((RESULT_URL_KEYS.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) || context) && mediaUrl.test(text)) {
        urls.push(text)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, context, key, mime, depth + 1)
      return
    }
    if (!isRecord(value) || seen.has(value)) return
    seen.add(value)
    const nextMime = imageMimeType(value) || mime
    for (const [rawKey, nested] of Object.entries(value)) {
      const normalizedKey = rawKey.trim()
      const lowerKey = normalizedKey.toLowerCase()
      if (lowerKey === 'poll_url' || lowerKey === 'pollurl' || lowerKey === 'poll_uri' || lowerKey === 'polluri') continue
      const isBase64 = RESULT_BASE64_KEYS.some((candidate) => candidate.toLowerCase() === lowerKey)
      const isUrl = RESULT_URL_KEYS.some((candidate) => candidate.toLowerCase() === lowerKey)
      const isContainer = RESULT_CONTAINER_KEYS.some((candidate) => candidate.toLowerCase() === lowerKey)
      if (isBase64 || isUrl || isContainer || context) visit(nested, context || isContainer || isBase64 || isUrl, normalizedKey, nextMime, depth + 1)
    }
  }
  if (typeof payload === 'string' && mediaUrl.test(payload.trim())) urls.push(payload.trim())
  else visit(payload, Array.isArray(payload))
  return [...new Set(urls)]
}

export function providerTaskId(payload: unknown): string {
  let found: string | undefined
  function search(value: unknown, depth = 0, allowGenericId = false, seen = new Set<object>()): string | undefined {
    if (depth > 10 || value === null || value === undefined) return undefined
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = search(item, depth + 1, false, seen)
        if (nested) return nested
      }
      return undefined
    }
    if (!isRecord(value) || seen.has(value)) return undefined
    seen.add(value)
    for (const key of TASK_ID_KEYS) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    }
    if (allowGenericId) {
      const candidate = value.id
      if ((typeof candidate === 'string' && candidate.trim()) || (typeof candidate === 'number' && Number.isFinite(candidate))) return String(candidate).trim()
    }
    for (const key of RESULT_CONTAINER_KEYS) {
      const nested = search(value[key], depth + 1, ['data', 'result', 'results', 'task', 'job', 'response', 'meta'].includes(key), seen)
      if (nested) return nested
    }
    return undefined
  }
  found = search(payload, 0, false)
  if (found) return found
  if (isRecord(payload)) {
    const status = String(payload.status ?? payload.state ?? '').toLowerCase()
    const activeStatus = ['pending', 'created', 'queued', 'in_queue', 'processing', 'running', 'in_progress'].includes(status)
    const terminalStatus = ['completed', 'succeeded', 'success', 'done', 'failed', 'cancelled', 'canceled', 'expired'].includes(status)
    const taskShape = Boolean(payload.poll_url || payload.pollUrl || payload.expires_at || payload.expiresAt || activeStatus
      || (terminalStatus && (resultUrls(payload).length > 0 || typeof payload.type === 'string')))
    const candidate = payload.id
    // Async providers sometimes return only { id } with no status or poll
    // metadata. Accept that shape when it is not also an error/result payload.
    if (!status && !resultUrls(payload).length && !resultError(payload)
      && ((typeof candidate === 'string' && candidate.trim()) || (typeof candidate === 'number' && Number.isFinite(candidate)))) {
      return String(candidate).trim()
    }
    if (taskShape && ((typeof candidate === 'string' && candidate.trim()) || (typeof candidate === 'number' && Number.isFinite(candidate)))) return String(candidate).trim()
  }
  return ''
}

export function resultError(payload: unknown): string | undefined {
  let message: string | undefined
  visitPayload(payload, (object, depth) => {
    if (message) return
    const error = object.error
    if (typeof error === 'string' && error.trim()) { message = error.trim(); return }
    if (isRecord(error)) {
      for (const key of ['message', 'detail', 'code']) if (typeof error[key] === 'string' && (error[key] as string).trim()) { message = (error[key] as string).trim(); return }
    }
    if (depth === 0 || ['failed', 'error'].includes(String(object.status ?? '').toLowerCase())) {
      for (const key of ['message', 'detail', 'error_message']) if (typeof object[key] === 'string' && (object[key] as string).trim()) { message = (object[key] as string).trim(); return }
    }
  })
  return message
}

function nestedValue(payload: unknown, keys: string[]): unknown {
  let found: unknown
  visitPayload(payload, (object) => {
    if (found !== undefined && found !== null && found !== '') return
    for (const key of keys) if (object[key] !== undefined && object[key] !== null && object[key] !== '') { found = object[key]; return }
  })
  return found
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

export async function getTask(id: string, session: StudioSession | string | undefined, signal?: AbortSignal, type?: 'image' | 'video') {
  if (!session) throw new Sub2ApiError(401, 'Please sign in to Cinlan Studio', 'AUTH_REQUIRED')
  const read = (target: 'image' | 'video', apiKey: string) => target === 'image'
    ? getImageTask(id, apiKey, signal)
    : getVideoTask(id, apiKey, signal)
  if (type) {
    if (typeof session === 'string') return read(type, session)
    return withStudioCredential(session, type, undefined, (credential) => read(type, credential.apiKey))
  }
  if (typeof session !== 'object') {
    try {
      return await read('image', session)
    } catch (error) {
      if (!(error instanceof Sub2ApiError) || error.status !== 404) throw error
    }
    return read('video', session)
  }
  try {
    return await withStudioCredential(session, 'image', undefined, async (credential) => read('image', credential.apiKey))
  } catch (error) {
    const unavailableImageCapability = error instanceof CreativeCoreError
      && ['STUDIO_FEATURE_NOT_CONFIGURED', 'STUDIO_GROUP_NOT_FOUND'].includes(error.code)
    if (!unavailableImageCapability && (!(error instanceof Sub2ApiError) || error.status !== 404)) throw error
  }
  return withStudioCredential(session, 'video', undefined, (credential) => read('video', credential.apiKey))
}
