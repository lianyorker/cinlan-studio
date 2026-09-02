import { NextResponse } from 'next/server'
import { requireGenerationSession, canonicalBody, mediaTaskDetails, normalizedStatus, providerTaskId, resultUrls } from '@/lib/server/generation'
import { newRequestId, Sub2ApiError, sub2apiFetch } from '@/lib/server/sub2api'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { withStudioCredential } from '@/lib/server/creative/provider-credentials'

export async function POST(request: Request) {
  try {
    const session = await requireGenerationSession()
    const input = await request.json() as Record<string, unknown>
    const body = canonicalBody(input)
    const model = String(input.model ?? '')
    const prompt = String(input.prompt ?? '')
    body.model = model
    body.prompt = prompt
    if (input.resolution !== undefined) body.resolution = input.resolution
    if (input.duration !== undefined) body.duration = input.duration
    const imageUrls = Array.isArray(input.imageUrls)
      ? input.imageUrls.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [input.imageUrl ?? input.image_url ?? input.image].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    delete body.imageUrls
    delete body.imageUrl
    delete body.image
    if (imageUrls.length > 1) body.image_urls = imageUrls
    else if (imageUrls.length === 1) body.image_url = imageUrls[0]
    if (input.count !== undefined) body.n = input.count
    if (!model || !prompt.trim()) return NextResponse.json({ message: '模型和 Prompt 不能为空' }, { status: 400 })
    const requestId = String(input.idempotency_key ?? newRequestId('video'))
    const result = await withStudioCredential(session, 'video', model, (credential) => sub2apiFetch<unknown>('/v1/videos/generations', {
      apiKey: credential.apiKey,
      method: 'POST',
      headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify(body),
    }))
    const id = providerTaskId(result) || requestId
    const details = mediaTaskDetails(result, id, 'video')
    const urls = resultUrls(result)
    const status = urls.length ? 'COMPLETED' : normalizedStatus(details.status)
    return NextResponse.json({ ...details, result_url: details.result_url || urls[0], result_urls: details.result_urls?.length ? details.result_urls : urls, status, estimated_cost: null })
  } catch (error) {
    if (error instanceof Sub2ApiError) {
      if (/videos api is not supported for this platform/i.test(error.message)) {
        return NextResponse.json({
          message: '当前 API Key 所在分组不支持视频生成，且该平台不能通过 sora-2 调用视频接口。请切换到模型目录实际返回的视频模型或分组后重试。',
          code: 'VIDEO_PLATFORM_UNSUPPORTED',
        }, { status: 409 })
      }
      return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
    }
    if (error instanceof CreativeCoreError) return creativeErrorResponse(error)
    return NextResponse.json({ message: error instanceof Error ? error.message : '视频生成失败' }, { status: 502 })
  }
}
