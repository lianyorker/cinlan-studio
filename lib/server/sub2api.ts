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

function parseEventStream(text: string): unknown {
  const events: Array<Record<string, unknown>> = []
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
      const value = JSON.parse(data) as Record<string, unknown>
      if (eventName && !value.type) value.type = eventName
      events.push(value)
    } catch {
      // Ignore keepalive and non-JSON SSE frames.
    }
    eventName = ''
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      flush()
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()

  return events.findLast((event) => String(event.type ?? '').endsWith('.completed'))
    ?? events.findLast((event) => typeof event.b64_json === 'string' || typeof event.url === 'string')
    ?? events.findLast((event) => event.error !== undefined)
    ?? text
}

export async function sub2apiFetch<T>(
  path: string,
  init: RequestInit & { accessToken?: string; apiKey?: string } = {}
): Promise<T> {
  const { accessToken, apiKey, ...requestInit } = init
  const headers = new Headers(requestInit.headers)
  headers.set('Accept', 'application/json')
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
      errorObject?.message
      ?? envelope?.message
      ?? (statusText && statusText !== '<none>' ? statusText : undefined)
      ?? `Sub2API request failed with HTTP ${response.status}`
    )
    const message = response.status >= 500 && /bad gateway|<html|nginx|cloudflare/i.test(rawMessage)
      ? 'Sub2API upstream request failed'
      : rawMessage
    const code = typeof errorObject?.code === 'string' ? errorObject.code : `UPSTREAM_HTTP_${response.status}`
    throw new Sub2ApiError(response.status, message, code, payload)
  }

  const envelope = payload as Envelope<T> | null
  if (envelope && typeof envelope === 'object' && typeof envelope.code === 'number' && envelope.data !== undefined) {
    return envelope.data as T
  }
  return payload as T
}

export function newRequestId(prefix = 'cinlan') {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
}
