import type { Model, Me, Task, GenerateResult, Example, CloudGeneration, Paginated } from './types'
import type { CreativeCoreConfig, CreativeEvent, CreativeJob } from './creative-types'

const BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '')
let embeddedBootstrap: Promise<boolean> | null = null

/** Resolve a media URL from the API. Relative paths get the configured API base prepended. */
export function mediaUrl(u: string | null | undefined): string {
  if (!u) return ''
  return u.startsWith('/') ? BASE + u : u
}

/** Request a server-side WebP thumbnail for local Creative Core assets. */
export function thumbUrl(u: string | null | undefined, width: number): string {
  if (!u) return ''
  if (u.startsWith('data:') || u.startsWith('blob:')) return u
  if (/^\/api\/v1\/creative\/assets\/asset_[a-f0-9-]+(?:\?|$)/i.test(u)) {
    const target = new URL(u, 'http://cinlan.local')
    target.searchParams.set('w', String(width))
    return `${BASE}${target.pathname}${target.search}${target.hash}`
  }
  return mediaUrl(u)
}

export function creativeAssetIdFromUrl(u: string | null | undefined) {
  if (!u) return null
  return u.match(/(?:^|\/)api\/v1\/creative\/assets\/(asset_[a-f0-9-]+)(?:\?|$)/i)?.[1] ?? null
}

export class ApiError extends Error {
  status: number
  code?: string
  extra?: Record<string, unknown>
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

async function streamRequest(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const multipart = typeof FormData !== 'undefined' && init?.body instanceof FormData
  if (init?.body && !multipart && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(BASE + path, { ...init, headers })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {}
    const message = String(typeof root.error === 'string' ? root.error : nested.message ?? root.message ?? res.statusText)
    const code = typeof (nested.code ?? root.code) === 'string' ? String(nested.code ?? root.code) : undefined
    throw new ApiError(res.status, message, code, Object.keys(nested).length ? nested : root)
  }
  return res
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) }
  const multipart = typeof FormData !== 'undefined' && init?.body instanceof FormData
  if (init?.body && !multipart) headers['Content-Type'] = 'application/json'

  const res = await fetch(BASE + path, { ...init, headers })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {}
    const message = String(typeof root.error === 'string' ? root.error : nested.message ?? root.message ?? res.statusText)
    const code = typeof (nested.code ?? root.code) === 'string' ? String(nested.code ?? root.code) : undefined
    throw new ApiError(res.status, message, code, Object.keys(nested).length ? nested : root)
  }
  return data as T
}

export function bootstrapEmbeddedSession() {
  if (typeof window === 'undefined') return Promise.resolve(false)
  const current = new URL(window.location.href)
  const token = current.searchParams.get('token')?.trim()
  if (!token) return Promise.resolve(false)
  if (embeddedBootstrap) return embeddedBootstrap

  const payload = {
    token,
    user_id: current.searchParams.get('user_id'),
    src_host: current.searchParams.get('src_host'),
  }
  for (const key of ['token', 'user_id', 'src_host', 'src_url']) current.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', `${current.pathname}${current.search}${current.hash}`)

  embeddedBootstrap = request<{ connected: boolean }>('/api/v1/auth/embed', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).then((response) => response.connected)
  return embeddedBootstrap
}

function dataUrlFile(value: string, index: number): File | null {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=]+)$/i.exec(value)
  if (!match) return null
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg')
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)
  return new File([bytes], `reference-${index + 1}.${extension}`, { type: mime })
}

function imageRequestBody(body: Record<string, unknown>): BodyInit {
  const values = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((value): value is string => typeof value === 'string')
    : typeof body.imageUrl === 'string' && body.imageUrl ? [body.imageUrl] : []
  const files = values.map(dataUrlFile).filter((file): file is File => file !== null)
  if (!files.length) return JSON.stringify(body)
  const form = new FormData()
  for (const [key, value] of Object.entries(body)) {
    if (key === 'imageUrl' || key === 'imageUrls') continue
    if (value === undefined || value === null) continue
    form.append(key, typeof value === 'string' ? value : String(value))
  }
  for (const file of files) form.append(files.length > 1 ? 'image[]' : 'image', file, file.name)
  return form
}

export const api = {
  models: () => request<{
    models: Model[]
    authoritative?: boolean
    degraded?: boolean
    reconnect_required?: boolean
    error?: { status?: number; code?: string; message?: string }
  }>('/api/v1/models', { cache: 'no-store' }),
  examples: (model: string, limit = 6) =>
    request<{ examples: Example[] }>(
      `/api/v1/examples?model=${encodeURIComponent(model)}&limit=${limit}`
    ),
  me: () => request<Me>('/api/v1/me'),
  creativeConfig: () => request<CreativeCoreConfig>('/api/v1/creative/config', { cache: 'no-store' }),
  creativeJobs: (active = false, page = 1, pageSize = 24) =>
    request<{ jobs: CreativeJob[]; pagination: Paginated }>(
      `/api/v1/creative/jobs?page=${page}&pageSize=${pageSize}${active ? '&active=1' : ''}`,
      { cache: 'no-store' }
    ),
  creativeJob: (id: string) => request<CreativeJob>(`/api/v1/creative/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' }),
  creativeEvents: (id: string, after = 0) =>
    request<{ events: CreativeEvent[] }>(`/api/v1/creative/jobs/${encodeURIComponent(id)}/events?after=${after}`, { cache: 'no-store' }),
  cancelCreativeJob: (id: string) =>
    request<CreativeJob>(`/api/v1/creative/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) }),
  retryCreativeJob: (id: string) =>
    request<CreativeJob>(`/api/v1/creative/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action: 'retry' }) }),
  deleteCreativeJob: (id: string) =>
    request<void>(`/api/v1/creative/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generateImage: (body: Record<string, unknown>) =>
    request<GenerateResult>('/api/v1/generate/image', { method: 'POST', body: imageRequestBody(body) }),
  generateVideo: (body: Record<string, unknown>) =>
    request<GenerateResult>('/api/v1/generate/video', { method: 'POST', body: JSON.stringify(body) }),
  generateText: (body: Record<string, unknown>) =>
    request<{ type: 'text'; model: string; prompt: string; result: unknown }>('/api/v1/generate/text', { method: 'POST', body: JSON.stringify(body) }),
  generateTextStream: (body: Record<string, unknown>, signal?: AbortSignal) =>
    streamRequest('/api/v1/generate/text', { method: 'POST', body: JSON.stringify({ ...body, stream: true }), signal }),
  task: (id: string, type?: 'image' | 'video') => request<Task>(`/api/v1/tasks/${encodeURIComponent(id)}${type ? `?type=${type}` : ''}`),
  generations: (type?: 'image' | 'video' | 'trending', page = 1, pageSize = 24) =>
    request<{ generations: CloudGeneration[]; pagination: Paginated }>(
      `/api/v1/generations?page=${page}&pageSize=${pageSize}${type ? `&type=${type}` : ''}`
    ),
  presign: (contentType: string, ext?: string) =>
    request<{ uploadUrl: string; publicUrl: string }>('/api/v1/upload', {
      method: 'POST',
      body: JSON.stringify({ contentType, ext }),
    }),
}

export function creativeEventStreamUrl(id: string, after = 0) {
  return `${BASE}/api/v1/creative/jobs/${encodeURIComponent(id)}/events?stream=1&after=${after}`
}

/** Presign + direct PUT to R2 (handles large images and videos). Returns the public URL. */
export async function uploadFile(file: File): Promise<string> {
  const form = new FormData()
  form.set('file', file)
  const response = await fetch('/api/v1/upload', { method: 'POST', body: form })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data?.message || 'Upload failed', data?.code)
  return String(data.publicUrl || data.url || '')
}
