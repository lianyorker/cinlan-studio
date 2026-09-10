import { NextResponse } from 'next/server'
import { requireGenerationSession } from '@/lib/server/generation'
import { safeIdempotencyKey, Sub2ApiError, sub2apiFetch, sub2apiStream } from '@/lib/server/sub2api'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { withStudioCredential } from '@/lib/server/creative/provider-credentials'

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

export const dynamic = 'force-dynamic'

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

function jsonAsTextStream(payload: unknown) {
  const body = `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
  return new Response(body, { headers: STREAM_HEADERS })
}

async function textStreamResponse(upstream: Response) {
  if (!upstream.body) return jsonAsTextStream(null)
  const contentType = (upstream.headers.get('content-type') ?? '').toLowerCase()
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let probe = ''
  let done = false
  const readProbe = async () => {
    while (!done) {
      const next = await reader.read()
      if (next.value) probe += decoder.decode(next.value, { stream: !next.done })
      done = next.done
      const trimmed = probe.trimStart()
      const sse = /^(?::|event|data):/.test(trimmed) || /(?:\n|\r)(?::|event|data):/.test(probe)
      const partialSse = ['e', 'ev', 'eve', 'even', 'event', 'event:', 'd', 'da', 'dat', 'data', 'data:', ':'].some((prefix) => trimmed === prefix)
      const hasMeaningfulText = trimmed.length > 0
      if (sse || (!partialSse && (trimmed.startsWith('{') || trimmed.startsWith('[') || (hasMeaningfulText && /[\n\r]/.test(probe)) || probe.length >= 256)) || done) break
    }
    probe += decoder.decode()
  }
  await readProbe()
  const trimmedProbe = probe.trimStart()
  const looksLikeSse = /^(?::|event|data):/.test(trimmedProbe) || /(?:\n|\r)(?::|event|data):/.test(probe)
  if (looksLikeSse) {
    const body = new ReadableStream({
      async start(controller) {
        try {
          if (probe) controller.enqueue(new TextEncoder().encode(probe))
          while (!done) {
            const next = await reader.read()
            if (next.value) controller.enqueue(next.value)
            done = next.done
          }
          controller.close()
        } catch (error) { controller.error(error) } finally { reader.releaseLock() }
      },
      cancel(reason) { return reader.cancel(reason) },
    })
    return new Response(body, { headers: STREAM_HEADERS })
  }
  let text = probe
  while (!done) {
    const next = await reader.read()
    if (next.value) text += decoder.decode(next.value, { stream: !next.done })
    done = next.done
  }
  reader.releaseLock()
  let payload: unknown = text
  try { payload = text ? JSON.parse(text) : null } catch { /* plain text fallback */ }
  return jsonAsTextStream(payload)
}

export async function POST(request: Request) {
  try {
    const session = await requireGenerationSession()
    const input = await request.json() as Record<string, unknown>
    const prompt = String(input.prompt ?? '').trim()
    const model = String(input.model ?? 'gpt-4.1-mini')
    const reasoningEffort = String(input.reasoning_effort ?? '').trim()
    if (!prompt) return NextResponse.json({ message: 'Prompt 不能为空' }, { status: 400 })
    if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
      return NextResponse.json({ message: '无效的 reasoning_effort' }, { status: 400 })
    }

    const wantsStream = input.stream === true
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: wantsStream,
    }
    if (reasoningEffort) body.reasoning_effort = reasoningEffort
    const requestId = safeIdempotencyKey(input.idempotency_key, 'text')

    if (!wantsStream) {
      const result = await withStudioCredential(session, 'text', model, (credential) => sub2apiFetch<unknown>('/v1/chat/completions', {
        apiKey: credential.apiKey,
        method: 'POST',
        headers: { 'Idempotency-Key': requestId },
        body: JSON.stringify(body),
        signal: request.signal,
      }))
      return NextResponse.json({ type: 'text', model, prompt, result })
    }
    const result = await withStudioCredential(session, 'text', model, (credential) => sub2apiStream('/v1/chat/completions', {
      apiKey: credential.apiKey,
      method: 'POST',
      headers: { 'Idempotency-Key': requestId, Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: request.signal,
    }))
    return textStreamResponse(result)
  } catch (error) {
    if (error instanceof Sub2ApiError || error instanceof CreativeCoreError) return creativeErrorResponse(error)
    return NextResponse.json({ message: error instanceof Error ? error.message : '文字生成失败' }, { status: 502 })
  }
}
