import { NextResponse } from 'next/server'
import { imageSizeIntentFromPrompt } from '@/lib/image-aspect-ratio'
import { requireGenerationSession, canonicalBody, mediaTaskDetails, providerTaskId, resultError, resultUrls } from '@/lib/server/generation'
import { newRequestId, Sub2ApiError, sub2apiFetch } from '@/lib/server/sub2api'
import { creativeCoreConfigured } from '@/lib/server/creative/config'
import { creativeTaskContract } from '@/lib/server/creative/contracts'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { submitCreativeImageJob } from '@/lib/server/creative/submission'
import { GPT_IMAGE_PROVIDER_SAFE_SIZE, isGptImageSizeValidationError, normalizeGptImageSize, shouldFallbackToSynchronousImageEndpoint } from '@/lib/server/creative/provider'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { withStudioCredential } from '@/lib/server/creative/provider-credentials'

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024
interface ReferenceImage {
  bytes: Uint8Array
  mime: string
  filename: string
}

function referenceImage(input: unknown) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=]+)$/i.exec(String(input ?? ''))
  if (!match) throw new Sub2ApiError(400, '参考图格式无效，请重新粘贴或上传 PNG、JPEG、WebP 图片', 'INVALID_REFERENCE_IMAGE')
  const bytes = Uint8Array.from(Buffer.from(match[2], 'base64'))
  if (!bytes.length || bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Sub2ApiError(400, '参考图大小必须在 20 MB 以内', 'INVALID_REFERENCE_IMAGE_SIZE')
  }
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg')
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)
  return { bytes, mime, filename: `reference.${extension}` }
}

async function fileReferenceImage(file: File): Promise<ReferenceImage> {
  if (!file.type.startsWith('image/')) throw new Sub2ApiError(400, '参考图必须是图片文件', 'INVALID_REFERENCE_IMAGE')
  if (file.size <= 0 || file.size > MAX_REFERENCE_IMAGE_BYTES) throw new Sub2ApiError(400, '参考图大小必须在 20 MB 以内', 'INVALID_REFERENCE_IMAGE_SIZE')
  const mime = file.type.toLowerCase().replace('image/jpg', 'image/jpeg')
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime, filename: file.name || 'reference.png' }
}

async function parseInput(request: Request): Promise<{ input: Record<string, unknown>; references: ReferenceImage[] }> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    const input = await request.json() as Record<string, unknown>
    const raw = Array.isArray(input.imageUrls) ? input.imageUrls : input.imageUrl ? [input.imageUrl] : []
    return { input, references: raw.filter(Boolean).map(referenceImage) }
  }
  const form = await request.formData()
  const input: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (key === 'image' || key === 'image[]' || value instanceof File) continue
    input[key] = value
  }
  const files = [...form.getAll('image'), ...form.getAll('image[]')].filter((value): value is File => value instanceof File)
  return { input, references: await Promise.all(files.map(fileReferenceImage)) }
}

function editPrompt(prompt: string, referenceCount: number, transparentBackground: boolean) {
  return [
    referenceCount > 1
      ? 'Use every attached image as visual input. Treat the first image as the primary composition and the remaining images as supporting identity, style, subject, or material references.'
      : 'Use the attached image as the primary visual reference.',
    'Follow the user instruction precisely while preserving recognizable identity and key visual elements unless the instruction explicitly asks to replace them.',
    transparentBackground
      ? 'Render the background with real alpha transparency. Never draw a checkerboard, gray-and-white grid, or simulated transparency pattern into the image.'
      : '',
    'Return one coherent, standalone finished image. Do not draw model names, comparison grids, UI chrome, or explanatory labels unless the user explicitly asks for those elements to appear in the image.',
    `User instruction: ${prompt}`,
  ].filter(Boolean).join('\n\n')
}

function editForm(input: Record<string, unknown>, references: ReferenceImage[], model: string, prompt: string, count: number, stream = false) {
  if (!references.length) throw new Sub2ApiError(400, '请先上传至少一张参考图', 'INVALID_REFERENCE_IMAGE')
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', editPrompt(prompt, references.length, String(input.background || '').toLowerCase() === 'transparent'))
  if (count > 1) form.append('n', String(count))
  for (const key of ['quality', 'size', 'background', 'output_format', 'output_compression', 'input_fidelity']) {
    if (input[key] !== undefined && input[key] !== '') form.append(key, String(input[key]))
  }
  if (stream) {
    form.append('stream', 'true')
    form.append('partial_images', '1')
  }
  for (const reference of references) {
    const buffer = new ArrayBuffer(reference.bytes.byteLength)
    new Uint8Array(buffer).set(reference.bytes)
    form.append(references.length > 1 ? 'image[]' : 'image', new Blob([buffer], { type: reference.mime }), reference.filename)
  }
  return form
}

function groupImageDisabled(error: unknown) {
  return error instanceof Sub2ApiError && /image generation is not enabled for this group/i.test(error.message)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request) {
  if (creativeCoreConfigured()) {
    try {
      return NextResponse.json(creativeTaskContract(await submitCreativeImageJob(request)))
    } catch (error) {
      return creativeErrorResponse(error)
    }
  }
  try {
    const session = await requireGenerationSession()
    const parsed = await parseInput(request)
    const input = parsed.input
    const references = parsed.references
    const body = canonicalBody(input)
    const count = Math.min(4, Math.max(1, Number(input.count ?? input.n ?? 1)))
    if (count > 1) body.n = count
    else delete body.n
    const model = String(input.model ?? '')
    const prompt = String(input.prompt ?? '')
    body.model = model
    body.prompt = prompt
    delete body.imageUrl
    delete body.imageUrls
    delete body.image
    if (input.quality !== undefined) body.quality = input.quality
    if (input.size !== undefined) body.size = input.size
    const promptSize = imageSizeIntentFromPrompt(prompt)
    const aspectRatio = String(input.aspect_ratio ?? input.aspectRatio ?? (/^gpt-image-/i.test(model) ? promptSize?.aspectRatio : '') ?? '')
    const resolution = String(input.resolution ?? '')
    if (/^gpt-image-/i.test(model)) {
      const requestedSize = promptSize?.source === 'dimensions' ? promptSize : undefined
      body.size = normalizeGptImageSize(body.size, aspectRatio, resolution || '1K', requestedSize)
      const outputFormat = String(body.output_format || '').toLowerCase()
      const background = String(body.background || '').toLowerCase()
      if (!outputFormat && background === 'transparent') body.output_format = 'png'
      delete body.aspect_ratio
    } else if (aspectRatio) {
      body.aspect_ratio = aspectRatio
    }
    delete body.aspectRatio
    if (!model || !prompt.trim()) return NextResponse.json({ message: '模型和 Prompt 不能为空' }, { status: 400 })
    const requestId = String(input.idempotency_key ?? newRequestId('image'))
    const headers = { 'Idempotency-Key': requestId }
    async function requestImage(apiKey: string, requestBody: Record<string, unknown>, requestHeaders: Record<string, string>, requestPrompt = prompt) {
      if (references.length) {
        try {
          return await sub2apiFetch('/v1/images/edits/async', {
            apiKey,
            method: 'POST',
            headers: requestHeaders,
            body: editForm(requestBody, references, model, requestPrompt, count),
          })
        } catch (error) {
          if (!shouldFallbackToSynchronousImageEndpoint(error)) throw error
          return sub2apiFetch('/v1/images/edits', {
            apiKey,
            method: 'POST',
            headers: { ...requestHeaders, Accept: 'text/event-stream' },
            body: editForm(requestBody, references, model, requestPrompt, count, true),
          })
        }
      }
      try {
        return await sub2apiFetch('/v1/images/generations/async', { apiKey, method: 'POST', headers: requestHeaders, body: JSON.stringify(requestBody) })
      } catch (error) {
        if (!shouldFallbackToSynchronousImageEndpoint(error)) throw error
        return sub2apiFetch('/v1/images/generations', { apiKey, method: 'POST', headers: requestHeaders, body: JSON.stringify(requestBody) })
      }
    }
    async function requestImageWithCompatibility(apiKey: string, requestBody: Record<string, unknown>, requestHeaders: Record<string, string>, requestPrompt = prompt) {
      try {
        return await requestImage(apiKey, requestBody, requestHeaders, requestPrompt)
      } catch (error) {
        if (!/^gpt-image-/i.test(model) || !isGptImageSizeValidationError(error) || requestBody.size === GPT_IMAGE_PROVIDER_SAFE_SIZE) throw error
        return requestImage(apiKey, { ...requestBody, size: GPT_IMAGE_PROVIDER_SAFE_SIZE }, requestHeaders, requestPrompt)
      }
    }
    const result = await withStudioCredential(session, 'image', model, async (credential) => {
      try {
        return await requestImageWithCompatibility(credential.apiKey, body, headers)
      } catch (error) {
        if (!groupImageDisabled(error)) throw error
        await wait(800)
        return requestImageWithCompatibility(credential.apiKey, body, headers)
      }
    })
    const id = providerTaskId(result)
    const urls = resultUrls(result)
    if (urls.length) {
      const resultId = id || requestId
      return NextResponse.json({ ...mediaTaskDetails(result, resultId, 'image'), status: 'COMPLETED', result_url: urls[0], result_urls: urls, estimated_cost: null })
    }
    if (id) return NextResponse.json({ ...mediaTaskDetails(result, id, 'image'), status: 'IN_PROGRESS', estimated_cost: null })
    const upstreamError = resultError(result)
    if (upstreamError) throw new Error(upstreamError)
    throw new Error('Sub2API 未返回图片任务 ID 或图片结果')
  } catch (error) {
    if (error instanceof Sub2ApiError || error instanceof CreativeCoreError) return creativeErrorResponse(error)
    return NextResponse.json({ message: error instanceof Error ? error.message : '图片生成失败' }, { status: 502 })
  }
}
