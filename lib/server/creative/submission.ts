import { randomUUID } from 'node:crypto'
import type { CreativeAnalysisMode, ModelCapabilities } from '@/lib/creative-types'
import { imageAspectRatioFromPrompt } from '@/lib/image-aspect-ratio'
import { imageRequestsTransparentBackground } from '@/lib/image-output'
import { assetIdFromUrl, parseDataImage, storeCreativeAsset } from './assets'
import { creativeSubmissionContext } from './context'
import { CreativeCoreError } from './errors'
import { createCreativeJob, creativeJobDto, getAssetForOwner, getJobForOwner, jobAssets } from './repository'
import { scheduleCreativeDrain } from './worker'
import { resolveModelCapabilities } from './capabilities'
import { resolveStudioCredential } from './provider-credentials'

type ParsedSubmission = {
  input: Record<string, unknown>
  imageFiles: File[]
  maskFile?: File
}

async function parseSubmission(request: Request): Promise<ParsedSubmission> {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return { input: await request.json() as Record<string, unknown>, imageFiles: [] }
  }
  const form = await request.formData()
  const input: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (value instanceof File) continue
    input[key] = value
  }
  const imageFiles = [...form.getAll('image'), ...form.getAll('image[]')].filter((value): value is File => value instanceof File)
  const mask = form.get('mask')
  return { input, imageFiles, maskFile: mask instanceof File ? mask : undefined }
}

function strings(input: unknown) {
  return Array.isArray(input) ? input.filter((value): value is string => typeof value === 'string') : typeof input === 'string' && input ? [input] : []
}

async function inputAssets(ownerId: string, parsed: ParsedSubmission) {
  const assets = []
  const urls = strings(parsed.input.imageUrls ?? parsed.input.imageUrl)
  if (parsed.imageFiles.length + urls.length > 4) throw new CreativeCoreError(400, 'TOO_MANY_REFERENCE_IMAGES', 'A maximum of four reference images is supported')
  for (const file of parsed.imageFiles) {
    assets.push(await storeCreativeAsset({ ownerId, kind: 'reference', bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, originalName: file.name }))
  }
  for (const value of urls) {
    const assetId = assetIdFromUrl(value)
    if (assetId) {
      assets.push(await getAssetForOwner(ownerId, assetId))
      continue
    }
    const data = parseDataImage(value)
    if (!data) throw new CreativeCoreError(400, 'INVALID_REFERENCE_IMAGE', 'Reference images must be uploaded creative assets')
    assets.push(await storeCreativeAsset({ ownerId, kind: 'reference', bytes: data.bytes, mime: data.mime, originalName: 'reference' }))
  }
  return assets
}

function normalizedParameters(input: Record<string, unknown>, capability: ModelCapabilities, prompt: string) {
  const requestedCount = Number(input.count ?? input.n ?? 1)
  if (!Number.isInteger(requestedCount) || requestedCount < 1) throw new CreativeCoreError(400, 'INVALID_OUTPUT_COUNT', 'Output count must be a positive integer')
  const count = Math.min(capability.max_outputs, Math.min(4, requestedCount))
  const aspectRatio = String(input.aspect_ratio ?? input.aspectRatio ?? imageAspectRatioFromPrompt(prompt, capability.aspect_ratios) ?? '')
  const quality = String(input.quality ?? capability.qualities[capability.qualities.length - 1] ?? '')
  const resolution = String(input.resolution ?? capability.resolutions[capability.resolutions.length - 1] ?? '')
  const analysisMode: CreativeAnalysisMode = input.analysis_mode === 'standard' ? 'standard' : 'deep'
  if (aspectRatio && !capability.aspect_ratios.includes(aspectRatio)) throw new CreativeCoreError(400, 'INVALID_ASPECT_RATIO', 'Selected model does not support this aspect ratio')
  if (quality && !capability.qualities.includes(quality)) throw new CreativeCoreError(400, 'INVALID_IMAGE_QUALITY', 'Selected model does not support this quality')
  if (resolution && !capability.resolutions.includes(resolution.toUpperCase())) throw new CreativeCoreError(400, 'INVALID_IMAGE_RESOLUTION', 'Selected model does not support this resolution')
  return {
    count,
    aspect_ratio: aspectRatio || undefined,
    quality: quality || undefined,
    resolution: resolution ? resolution.toUpperCase() : undefined,
    analysis_mode: analysisMode,
    background: input.background || undefined,
    output_format: input.output_format || undefined,
    output_compression: input.output_compression || undefined,
    input_fidelity: input.input_fidelity || undefined,
    parent_job_id: typeof input.parent_job_id === 'string' ? input.parent_job_id : undefined,
  }
}

export async function submitCreativeImageJob(request: Request) {
  const { session, owner } = await creativeSubmissionContext()
  const parsed = await parseSubmission(request)
  const model = String(parsed.input.model || '').trim()
  const prompt = String(parsed.input.prompt || '').trim()
  if (!model || !prompt) throw new CreativeCoreError(400, 'INVALID_CREATIVE_REQUEST', 'Model and prompt are required')
  if (model.length > 200 || prompt.length > 8000) throw new CreativeCoreError(400, 'CREATIVE_REQUEST_TOO_LARGE', 'Model or prompt exceeds the supported length')
  const providerCredential = await resolveStudioCredential(session, 'image', model)
  const capability = await resolveModelCapabilities(model, 'image')
  if (!capability?.text_to_image) throw new CreativeCoreError(400, 'MODEL_IMAGE_UNSUPPORTED', 'Selected model does not support image generation')
  const references = await inputAssets(owner.id, parsed)
  if (references.length && !capability.image_edit) throw new CreativeCoreError(400, 'MODEL_EDIT_UNSUPPORTED', 'Selected model does not support image editing')
  if (references.length > capability.max_reference_images) throw new CreativeCoreError(400, 'TOO_MANY_REFERENCE_IMAGES', 'Selected model does not support this many reference images')
  let maskAssetId: string | undefined
  if (parsed.maskFile) {
    if (!capability.mask) throw new CreativeCoreError(400, 'MODEL_MASK_UNSUPPORTED', 'Selected model does not support mask editing')
    const mask = await storeCreativeAsset({ ownerId: owner.id, kind: 'mask', bytes: new Uint8Array(await parsed.maskFile.arrayBuffer()), mime: parsed.maskFile.type, originalName: parsed.maskFile.name })
    maskAssetId = mask.id
  }
  const parameters: Record<string, unknown> = normalizedParameters(parsed.input, capability, prompt)
  parameters.provider_credential_id = providerCredential.id || undefined
  parameters.provider_group_id = providerCredential.groupId || undefined
  parameters.provider_credential_rotation = providerCredential.rotationVersion
  parameters.provider_credential_retry_count = 0
  parameters.provider_credential_rejected_rotation = 0
  if (/^gpt-image-/i.test(model) && !parameters.background && imageRequestsTransparentBackground(prompt)) {
    parameters.background = 'transparent'
    parameters.output_format ||= 'png'
  }
  const parentJobId = typeof parameters.parent_job_id === 'string' ? parameters.parent_job_id : undefined
  if (parentJobId) {
    const parent = await getJobForOwner(owner.id, parentJobId)
    if (parent.status !== 'COMPLETED' && parent.status !== 'PARTIAL_SUCCESS') {
      throw new CreativeCoreError(409, 'PARENT_JOB_NOT_COMPLETED', 'Parent creative job is not completed')
    }
    const parentOutputs = await jobAssets(parent.id, 'output')
    if (!parentOutputs.some((output) => references.some((reference) => reference.id === output.id))) {
      throw new CreativeCoreError(400, 'PARENT_ASSET_REQUIRED', 'A parent job result must be included as a reference image')
    }
  }
  const rawIdempotencyKey = String(parsed.input.idempotency_key || `image_${randomUUID()}`).trim()
  if (!rawIdempotencyKey || rawIdempotencyKey.length > 200) throw new CreativeCoreError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency key must be between 1 and 200 characters')
  const job = await createCreativeJob({
    ownerId: owner.id,
    mode: references.length ? 'EDIT' : 'GENERATE',
    model,
    prompt,
    parameters,
    idempotencyKey: rawIdempotencyKey,
    inputAssetIds: references.map((asset) => asset.id),
    maskAssetId,
  })
  scheduleCreativeDrain()
  return creativeJobDto(job)
}
