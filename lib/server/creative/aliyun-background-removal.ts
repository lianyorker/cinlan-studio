import { Readable } from 'node:stream'
import ImagesegClient, { SegmentCommonImageAdvanceRequest } from '@alicloud/imageseg20191230'
import { $OpenApiUtil } from '@alicloud/openapi-core'
import * as $dara from '@darabonba/typescript'
import sharp from 'sharp'
import { CreativeCoreError } from './errors'

const ALIYUN_MAX_INPUT_BYTES = 3 * 1024 * 1024
const ALIYUN_MAX_EDGE = 1999

function aliyunClient() {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim()
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim()
  if (!accessKeyId || !accessKeySecret) {
    throw new CreativeCoreError(503, 'ALIYUN_IMAGESEG_NOT_CONFIGURED', 'Alibaba Cloud image segmentation is not configured')
  }
  const regionId = process.env.ALIBABA_CLOUD_REGION_ID?.trim() || 'cn-shanghai'
  const config = new $OpenApiUtil.Config({
    accessKeyId,
    accessKeySecret,
    regionId,
    endpoint: process.env.ALIBABA_CLOUD_IMAGESEG_ENDPOINT?.trim() || `imageseg.${regionId}.aliyuncs.com`,
  })
  return new ImagesegClient(config)
}

export async function normalizeAliyunInput(bytes: Uint8Array) {
  const source = sharp(Buffer.from(bytes), { failOn: 'error', sequentialRead: true }).rotate()
  for (const [edge, quality] of [[ALIYUN_MAX_EDGE, 90], [ALIYUN_MAX_EDGE, 80], [1600, 76], [1280, 72]] as const) {
    const output = await source.clone()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
    if (output.length <= ALIYUN_MAX_INPUT_BYTES) return output
  }
  throw new CreativeCoreError(413, 'ALIYUN_IMAGESEG_INPUT_TOO_LARGE', 'Image could not be normalized for Alibaba Cloud segmentation')
}

function providerError(error: unknown) {
  if (error instanceof CreativeCoreError) return error
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {}
  const code = String(data.Code ?? value.code ?? 'ALIYUN_IMAGESEG_FAILED')
  const message = String(data.Message ?? value.message ?? 'Alibaba Cloud image segmentation failed')
  const status = /Throttl|TooMany|Quota/i.test(code) ? 429 : /InvalidAccessKey|Forbidden|Unauthorized/i.test(code) ? 502 : 502
  return new CreativeCoreError(status, code, message)
}

export async function removeBackgroundWithAliyun(bytes: Uint8Array, beforeRequest?: () => Promise<void>) {
  try {
    const input = await normalizeAliyunInput(bytes)
    const client = aliyunClient()
    const request = new SegmentCommonImageAdvanceRequest({
      imageURLObject: Readable.from(input),
    })
    const runtime = new $dara.RuntimeOptions({
      connectTimeout: 10_000,
      readTimeout: 90_000,
      autoretry: false,
    })
    await beforeRequest?.()
    const response = await client.segmentCommonImageAdvance(request, runtime)
    const imageUrl = response.body?.data?.imageURL
    if (!imageUrl) throw new CreativeCoreError(502, 'ALIYUN_IMAGESEG_EMPTY_RESULT', 'Alibaba Cloud image segmentation returned no image')
    return { imageUrl, requestId: response.body?.requestId || '' }
  } catch (error) {
    throw providerError(error)
  }
}
