import { NextResponse } from 'next/server'
import { requireGenerationSession } from '@/lib/server/generation'
import { Sub2ApiError, sub2apiFetch } from '@/lib/server/sub2api'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { withStudioCredential } from '@/lib/server/creative/provider-credentials'

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

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

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }
    if (reasoningEffort) body.reasoning_effort = reasoningEffort
    const requestId = String(input.idempotency_key ?? `text_${Date.now()}`)

    const result = await withStudioCredential(session, 'text', model, (credential) => sub2apiFetch<unknown>('/v1/chat/completions', {
      apiKey: credential.apiKey,
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify(body),
    }))
    return NextResponse.json({ type: 'text', model, prompt, result })
  } catch (error) {
    if (error instanceof Sub2ApiError || error instanceof CreativeCoreError) return creativeErrorResponse(error)
    return NextResponse.json({ message: error instanceof Error ? error.message : '文字生成失败' }, { status: 502 })
  }
}
