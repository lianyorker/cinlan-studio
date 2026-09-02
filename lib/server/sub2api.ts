import { randomBytes } from 'node:crypto'

type Envelope<T> = { code?: number; message?: string; data?: T } & Record<string, unknown>

const rawBase = process.env.SUB2API_BASE_URL || process.env.NEXT_PUBLIC_SUB2API_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api.cinlan.online'

export const SUB2API_BASE_URL = rawBase.replace(/\/$/, '').replace(/\/v1$/, '')

export class Sub2ApiError extends Error {
  status: number
  code?: string
  details?: unknown

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message)
    this.name = 'Sub2ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function parseEventStream(text: string): unknown {
  const events: unknown[] = []
  let eventName = ''
  let dataLines: string[] = []

  function flush() {
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') {
      eventName = ''
      return
    }
    try {
      const parsed = JSON.parse(data) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = { ...(parsed as Record<string, unknown>) }
        if (eventName && !value.type) value.type = eventName
        events.push(value)
      } else {
        events.push(parsed)
      }
    } catch {
      // Ignore keepalive and non-JSON SSE frames.
    }
    eventName = ''
  }

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line) {
      flush()
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  flush()

  const objects = events.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === 'object' && !Array.isArray(event))
  if (!events.length) return text
  if (events.length === 1) return events[0]
  // Keep every frame: providers commonly put the task ID in an initial
  // frame and the final image in a later frame. Returning only the last
  // frame loses one half of that response and causes false 502 errors.
  return { ...objects.reduce<Record<string, unknown>>((merged, event) => ({ ...merged, ...event }), {}), events }
}

export async function sub2apiFetch<T>(
  path: string,
  init: RequestInit & { accessToken?: string; apiKey?: string } = {}
): Promise<T> {
  const { accessToken, apiKey, ...requestInit } = init
  const headers = new Headers(requestInit.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  const multipart = typeof FormData !== 'undefined' && requestInit.body instanceof FormData
  if (requestInit.body && !multipart && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  else if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)

  let response: Response
  try {
    response = await fetch(`${SUB2API_BASE_URL}${path}`, {
      ...requestInit,
      headers,
      cache: 'no-store',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Sub2ApiError(504, 'Sub2API upstream request timed out', 'SUB2API_TIMEOUT')
    }
    throw new Sub2ApiError(502, 'Sub2API upstream request failed', 'SUB2API_FETCH_FAILED', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let payload: unknown = null
  if (contentType.includes('text/event-stream') || /^\s*(?:event|data):/m.test(text)) {
    payload = parseEventStream(text)
  } else {
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
  }

  if (!response.ok) {
    const envelope = payload as Envelope<unknown> | null
    const errorValue = envelope && typeof envelope === 'object' ? envelope.error : undefined
    const errorObject = errorValue && typeof errorValue === 'object' ? errorValue as Record<string, unknown> : null
    const statusText = response.statusText?.trim()
    const rawMessage = String(
      typeof errorValue === 'string' ? errorValue
      : errorObject?.message
      ?? envelope?.message
      ?? (statusText && statusText !== '<none>' ? statusText : undefined)
      ?? `Sub2API request failed with HTTP ${response.status}`
    )
    const message = response.status >= 500 && /bad gateway|<html|nginx|cloudflare/i.test(rawMessage)
      ? 'Sub2API upstream request failed'
      : rawMessage
    const code = typeof errorObject?.code === 'string' ? errorObject.code : typeof (envelope as Record<string, unknown>)?.code === 'string' ? String((envelope as Record<string, unknown>).code) : `UPSTREAM_HTTP_${response.status}`
    throw new Sub2ApiError(response.status, message, code, payload)
  }

  const envelope = payload as Envelope<T> | null
  if (envelope && typeof envelope === 'object' && typeof envelope.code === 'number' && envelope.data !== undefined) {
    return envelope.data as T
  }
  return payload as T
}

export async function sub2apiStream(
  path: string,
  init: RequestInit & { accessToken?: string; apiKey?: string } = {},
): Promise<Response> {
  const { accessToken, apiKey, ...requestInit } = init
  const headers = new Headers(requestInit.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'text/event-stream')
  const multipart = typeof FormData !== 'undefined' && requestInit.body instanceof FormData
  if (requestInit.body && !multipart && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  else if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`)

  let response: Response
  try {
    response = await fetch(`${SUB2API_BASE_URL}${path}`, {
      ...requestInit,
      headers,
      cache: 'no-store',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Sub2ApiError(504, 'Sub2API upstream request timed out', 'SUB2API_TIMEOUT')
    }
    throw new Sub2ApiError(502, 'Sub2API upstream request failed', 'SUB2API_FETCH_FAILED', {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (response.ok) return response

  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let payload: unknown = null
  if (contentType.includes('text/event-stream') || /^\s*(?:event|data):/m.test(text)) {
    payload = parseEventStream(text)
  } else {
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
  }
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const errorValue = envelope.error
  const errorObject = errorValue && typeof errorValue === 'object' ? errorValue as Record<string, unknown> : null
  const statusText = response.statusText?.trim()
  const rawMessage = String(
    typeof errorValue === 'string' ? errorValue
    : errorObject?.message
    ?? envelope.message
    ?? (statusText && statusText !== '<none>' ? statusText : undefined)
    ?? `Sub2API request failed with HTTP ${response.status}`
  )
  const message = response.status >= 500 && /bad gateway|<html|nginx|cloudflare/i.test(rawMessage)
    ? 'Sub2API upstream request failed'
    : rawMessage
  const code = typeof errorObject?.code === 'string' ? errorObject.code : typeof envelope.code === 'string' ? envelope.code : `UPSTREAM_HTTP_${response.status}`
  throw new Sub2ApiError(response.status, message, code, payload)
}
export function newRequestId(prefix = 'cinlan') {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
}
