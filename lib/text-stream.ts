export interface SseFrame {
  event: string
  data: string
}

/** Split an SSE buffer without losing a frame that spans network chunks. */
export function takeSseFrames(buffer: string, flush = false): { frames: SseFrame[]; remainder: string } {
  // Keep a trailing CR until the next network chunk supplies its LF.
  const normalized = flush
    ? buffer.replace(/\r\n?/g, '\n')
    : buffer.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n')
  const parts = normalized.split('\n\n')
  const remainder = flush ? '' : (parts.pop() ?? '')
  const frames = parts.map(parseSseFrame).filter((frame): frame is SseFrame => frame !== null)
  if (flush && remainder) {
    const last = parseSseFrame(remainder)
    if (last) frames.push(last)
  }
  return { frames, remainder }
}

export function parseSseFrame(frame: string): SseFrame | null {
  let event = 'message'
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message'
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  const value = data.join('\n')
  return value.length ? { event, data: value } : null
}

export function parseJsonData(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '[DONE]') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function textPart(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => textPart(item, depth + 1, seen)).join('')
  if (typeof value !== 'object') return ''
  if (seen.has(value)) return ''
  seen.add(value)
  const object = value as Record<string, unknown>
  for (const key of ['text', 'content', 'output_text', 'outputText', 'value', 'message', 'delta']) {
    if (object[key] !== undefined) {
      const result = textPart(object[key], depth + 1, seen)
      if (result) return result
    }
  }
  if (Array.isArray(object.choices)) {
    for (const choice of object.choices) {
      const result = textPart(choice, depth + 1, seen)
      if (result) return result
    }
  }
  return ''
}

/** Merge a provider chunk into the rendered text without duplicating snapshots. */
export function appendTextDelta(current: string, next: string): string {
  if (!next) return current
  if (!current) return next
  if (next === current) return current
  if (next.startsWith(current)) return next
  if (current.startsWith(next)) return current
  return current + next
}
/** Extract only an incremental token/chunk, not a completed message snapshot. */
export function incrementalTextFromPayload(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const object = value as Record<string, unknown>
  const choices = Array.isArray(object.choices) ? object.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const item = choice as Record<string, unknown>
    if (item.delta !== undefined) {
      const text = textPart(item.delta)
      if (text) return text
    }
    if (typeof item.text === 'string' && item.text) return item.text
  }
  if (object.delta !== undefined) {
    const text = textPart(object.delta)
    if (text) return text
  }
  const eventType = String(object.type ?? '').toLowerCase()
  if (/(?:delta|chunk|token)/.test(eventType)) {
    for (const key of ['content', 'text', 'output_text', 'outputText', 'value']) {
      const text = textPart(object[key])
      if (text) return text
    }
  }
  return ''
}
/** Extract text from OpenAI-compatible deltas and common provider variants. */
export function textDeltaFromPayload(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const object = value as Record<string, unknown>
  const choices = Array.isArray(object.choices) ? object.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const item = choice as Record<string, unknown>
    const delta = item.delta
    if (delta !== undefined) {
      const text = textPart(delta)
      if (text) return text
    }
    const message = item.message
    if (message !== undefined) {
      const text = textPart(message)
      if (text) return text
    }
    for (const key of ['text', 'content']) {
      const text = textPart(item[key])
      if (text) return text
    }
  }
  for (const key of ['delta', 'content', 'output_text', 'outputText', 'text']) {
    const text = textPart(object[key])
    if (text) return text
  }
  for (const key of ['result', 'output', 'response', 'data']) {
    if (object[key] === undefined) continue
    const text = textPart(object[key])
    if (text) return text
  }
  return ''
}

export function errorMessageFromPayload(value: unknown, depth = 0, seen = new Set<object>()): string | undefined {
  if (!value || typeof value !== 'object') return typeof value === 'string' && value.trim() ? value.trim() : undefined
  if (depth > 6 || seen.has(value)) return undefined
  seen.add(value)
  const object = value as Record<string, unknown>
  const error = object.error
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object') {
    const nested = error as Record<string, unknown>
    for (const key of ['message', 'detail', 'code']) {
      if (typeof nested[key] === 'string' && nested[key].trim()) return nested[key].trim()
    }
  }
  for (const key of ['message', 'detail', 'error_message']) {
    if (typeof object[key] === 'string' && object[key].trim()) return (object[key] as string).trim()
  }
  for (const key of ['data', 'result', 'response', 'output']) {
    const nested = errorMessageFromPayload(object[key], depth + 1, seen)
    if (nested) return nested
  }
  return undefined
}
