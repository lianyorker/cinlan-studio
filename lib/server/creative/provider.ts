import { mediaTaskDetails, providerTaskId, resultError, resultUrls } from '../generation'
import { newRequestId, Sub2ApiError, sub2apiFetch } from '../sub2api'

export interface ProviderReference {
  bytes: Uint8Array
  mime: string
  filename: string
  role: 'input' | 'mask'
}

type ImageDimensions = { width: number; height: number }

// GPT Image 2 accepts flexible dimensions, but the generated canvas still has
// hard pixel/grid limits. These canonical canvases avoid values such as
// 1024x680 (not a valid 16px grid) when translating an aspect ratio.
const GPT_IMAGE_SIZE_TABLE: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '3:2': { '1K': '1536x1024', '2K': '2400x1600', '4K': '3456x2304' },
  '2:3': { '1K': '1024x1536', '2K': '1600x2400', '4K': '2304x3456' },
  '4:3': { '1K': '1152x864', '2K': '2048x1536', '4K': '3264x2448' },
  '3:4': { '1K': '864x1152', '2K': '1536x2048', '4K': '2448x3264' },
  '5:4': { '1K': '1120x896', '2K': '2240x1792', '4K': '3200x2560' },
  '4:5': { '1K': '896x1120', '2K': '1792x2240', '4K': '2560x3200' },
  '16:9': { '1K': '1280x720', '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '1K': '720x1280', '2K': '1152x2048', '4K': '2160x3840' },
  '21:9': { '1K': '1344x576', '2K': '2016x864', '4K': '3808x1632' },
  '3:1': { '1K': '1536x512', '2K': '2400x800', '4K': '3840x1280' },
  '1:3': { '1K': '512x1536', '2K': '800x2400', '4K': '1280x3840' },
}
const GPT_IMAGE_SIZE_RATIOS = Object.keys(GPT_IMAGE_SIZE_TABLE)
const GPT_IMAGE_MIN_PIXELS = 655_360
const GPT_IMAGE_MAX_PIXELS = 8_294_400
const GPT_IMAGE_MAX_EDGE = 3840
// Some OpenAI-compatible Sub2API groups expose a smaller, finite canvas
// catalogue than the GPT Image API. This is the safest common fallback.
export const GPT_IMAGE_PROVIDER_SAFE_SIZE = '1024x1024'

export function isGptImageSizeValidationError(error: unknown) {
  if (!(error instanceof Sub2ApiError)) return false
  const text = `${error.code || ''} ${error.message}`
  return /size\s+must\s+be\s+a\s+width\s*[x×]?\s*height\s+string/i.test(text)
    || /\$?width\s+must\s+be\s+one\s+of\b/i.test(text)
    || /\$?height\s+must\s+be\s+one\s+of\b/i.test(text)
    || /invalid\s+(?:image\s+)?size\b/i.test(text)
}

function parseImageDimensions(value: unknown): ImageDimensions | undefined {
  const match = /^([0-9]{1,6})[ \t]*[xX×*][ \t]*([0-9]{1,6})$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined
}

function formatImageDimensions(dimensions: ImageDimensions) {
  return String(dimensions.width) + 'x' + String(dimensions.height)
}

export function isValidGptImageSize(value: unknown): value is string {
  const dimensions = parseImageDimensions(value)
  if (!dimensions) return false
  const { width, height } = dimensions
  const pixels = width * height
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  return width % 16 === 0
    && height % 16 === 0
    && longEdge <= GPT_IMAGE_MAX_EDGE
    && pixels >= GPT_IMAGE_MIN_PIXELS
    && pixels <= GPT_IMAGE_MAX_PIXELS
    && longEdge <= shortEdge * 3
}

function aspectRatioValue(value: string) {
  const match = /^([0-9]+(?:\.[0-9]+)?)[ \t]*[:：][ \t]*([0-9]+(?:\.[0-9]+)?)$/.exec(value.trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : undefined
}

function nearestRatioKey(value: number) {
  let closest = '1:1'
  let distance = Number.POSITIVE_INFINITY
  for (const candidate of GPT_IMAGE_SIZE_RATIOS) {
    const candidateValue = aspectRatioValue(candidate)
    if (!candidateValue) continue
    const nextDistance = Math.abs(Math.log(value / candidateValue))
    if (nextDistance < distance) {
      closest = candidate
      distance = nextDistance
    }
  }
  return closest
}

function resolutionKey(value: string) {
  const normalized = value.trim().toUpperCase()
  return normalized === '2K' || normalized === '4K' ? normalized : '1K'
}

/** Return a provider-safe GPT Image canvas for an aspect ratio/resolution. */
export function sizeForResolution(aspectRatio: string, resolution: string, requested?: ImageDimensions) {
  if (requested && isValidGptImageSize(formatImageDimensions(requested))) return formatImageDimensions(requested)
  const requestedRatio = requested && requested.width > 0 && requested.height > 0
    ? requested.width / requested.height
    : undefined
  const ratio = requestedRatio ?? aspectRatioValue(aspectRatio) ?? 1
  return GPT_IMAGE_SIZE_TABLE[nearestRatioKey(ratio)]?.[resolutionKey(resolution)] ?? GPT_IMAGE_SIZE_TABLE['1:1']['1K']
}

/** Normalize a user/provider size while preserving valid custom dimensions. */
export function normalizeGptImageSize(value: unknown, aspectRatio: string, resolution: string, requested?: ImageDimensions) {
  const explicit = parseImageDimensions(value)
  if (explicit && isValidGptImageSize(formatImageDimensions(explicit))) return formatImageDimensions(explicit)
  // Preserve the shape of an invalid explicit size while translating it to the
  // nearest provider-safe canvas; never let a malformed custom size fall back
  // to an unrelated square canvas.
  return sizeForResolution(aspectRatio, resolution, requested ?? explicit)
}

function legacyEditPrompt(prompt: string, referenceCount: number, transparentBackground: boolean) {
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

function editForm(input: {
  model: string
  prompt: string
  count: number
  parameters: Record<string, unknown>
  references: ProviderReference[]
  compiled: boolean
  stream?: boolean
}) {
  const images = input.references.filter((reference) => reference.role === 'input')
  const mask = input.references.find((reference) => reference.role === 'mask')
  const form = new FormData()
  form.append('model', input.model)
  form.append('prompt', input.compiled ? input.prompt : legacyEditPrompt(input.prompt, images.length, String(input.parameters.background || '').toLowerCase() === 'transparent'))
  if (input.count > 1) form.append('n', String(input.count))
  for (const key of ['quality', 'size', 'background', 'output_format', 'output_compression', 'input_fidelity']) {
    if (input.parameters[key] !== undefined && input.parameters[key] !== '') form.append(key, String(input.parameters[key]))
  }
  if (input.stream) {
    form.append('stream', 'true')
    form.append('partial_images', '1')
  }
  for (const reference of images) {
    const copy = new Uint8Array(reference.bytes)
    form.append(images.length > 1 ? 'image[]' : 'image', new Blob([copy], { type: reference.mime }), reference.filename)
  }
  if (mask) {
    const copy = new Uint8Array(mask.bytes)
    form.append('mask', new Blob([copy], { type: mask.mime }), mask.filename)
  }
  return form
}

function retryableGroupError(error: unknown) {
  return error instanceof Sub2ApiError && /image generation is not enabled for this group/i.test(error.message)
}

export function transparentBackgroundUnsupported(error: unknown) {
  return error instanceof Sub2ApiError && /transparent background is not supported|background.*transparent.*not supported/i.test(error.message)
}

export function shouldFallbackToSynchronousImageEndpoint(error: unknown) {
  if (!(error instanceof Sub2ApiError)) return false
  if ([404, 405, 501].includes(error.status)) return true
  const code = String(error.code ?? '').toLowerCase()
  return /async.*(?:disabled|unsupported|not.?found)/.test(code)
    || /async image (?:tasks? )?(?:are )?(?:disabled|unsupported)|async image storage disabled/i.test(error.message)
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

export async function requestProviderImage(input: {
  apiKey: string
  model: string
  prompt: string
  count: number
  parameters: Record<string, unknown>
  references: ProviderReference[]
  idempotencyKey: string
  compiled?: boolean
  signal?: AbortSignal
}) {
  const parameters = { ...input.parameters }
  const aspectRatio = String(parameters.aspect_ratio ?? parameters.aspectRatio ?? '')
  const resolution = String(parameters.resolution ?? '')
  if (/^gpt-image-/i.test(input.model)) {
    const requestedWidth = Number(parameters.requested_width || 0)
    const requestedHeight = Number(parameters.requested_height || 0)
    const requested = requestedWidth > 0 && requestedHeight > 0 ? { width: requestedWidth, height: requestedHeight } : undefined
    parameters.size = normalizeGptImageSize(parameters.size, aspectRatio, resolution || '1K', requested)
    const outputFormat = String(parameters.output_format || '').toLowerCase()
    const background = String(parameters.background || '').toLowerCase()
    if (!outputFormat && background === 'transparent') parameters.output_format = 'png'
    delete parameters.aspect_ratio
    delete parameters.aspectRatio
  }
  delete parameters.resolution
  delete parameters.requested_width
  delete parameters.requested_height
  delete parameters.analysis_mode
  delete parameters.parent_job_id
  delete parameters.idempotency_key
  delete parameters.count

  async function send(requestParameters: Record<string, unknown>, requestPrompt: string, idempotencyKey: string) {
    const headers = { 'Idempotency-Key': idempotencyKey }
    if (input.references.some((reference) => reference.role === 'input')) {
      try {
        return await sub2apiFetch<unknown>('/v1/images/edits/async', {
          apiKey: input.apiKey,
          method: 'POST',
          headers,
          body: editForm({ ...input, prompt: requestPrompt, parameters: requestParameters, stream: false, compiled: input.compiled ?? false }),
          signal: requestSignal(input.signal, 45_000),
        })
      } catch (error) {
        if (!shouldFallbackToSynchronousImageEndpoint(error)) throw error
        return sub2apiFetch<unknown>('/v1/images/edits', {
          apiKey: input.apiKey,
          method: 'POST',
          headers: { ...headers, Accept: 'text/event-stream' },
          body: editForm({ ...input, prompt: requestPrompt, parameters: requestParameters, stream: true, compiled: input.compiled ?? false }),
          signal: requestSignal(input.signal, 240_000),
        })
      }
    }

    const body = {
      ...requestParameters,
      model: input.model,
      prompt: requestPrompt,
      ...(input.count > 1 ? { n: input.count } : {}),
    }
    try {
      return await sub2apiFetch<unknown>('/v1/images/generations/async', { apiKey: input.apiKey, method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal(input.signal, 45_000) })
    } catch (error) {
      if (!shouldFallbackToSynchronousImageEndpoint(error)) throw error
      return sub2apiFetch<unknown>('/v1/images/generations', { apiKey: input.apiKey, method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal(input.signal, 240_000) })
    }
  }

  async function sendWithSizeCompatibility(requestPrompt: string, idempotencyKey: string) {
    try {
      return await send(parameters, requestPrompt, idempotencyKey)
    } catch (error) {
      if (!isGptImageSizeValidationError(error) || parameters.size === GPT_IMAGE_PROVIDER_SAFE_SIZE) throw error
      const fallbackParameters = { ...parameters, size: GPT_IMAGE_PROVIDER_SAFE_SIZE }
      return send(fallbackParameters, requestPrompt, idempotencyKey)
    }
  }

  let payload: unknown
  try {
    payload = await sendWithSizeCompatibility(input.prompt, input.idempotencyKey)
  } catch (error) {
    if (!retryableGroupError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 800))
    payload = await sendWithSizeCompatibility(input.prompt, input.idempotencyKey)
  }
  const id = providerTaskId(payload)
  const urls = resultUrls(payload)
  if (urls.length) return { ...mediaTaskDetails(payload, id || newRequestId('image'), 'image'), status: 'COMPLETED' as const, result_urls: urls }
  if (id) return { ...mediaTaskDetails(payload, id, 'image'), status: 'IN_PROGRESS' as const, result_urls: [] }
  const upstreamError = resultError(payload)
  throw new Sub2ApiError(502, upstreamError || 'Image provider returned neither a task ID nor an image result', 'INVALID_PROVIDER_RESPONSE', payload)
}
