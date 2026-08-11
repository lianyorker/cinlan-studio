import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { creativeAssetRoot } from './config'
import { CreativeCoreError } from './errors'
import { createAssetRecord, findAssetByHash, getAssetInternal, type AssetRecord } from './repository'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const THUMBNAIL_QUALITY = 80
const THUMBNAIL_VERSION = 1
export const CREATIVE_THUMBNAIL_WIDTHS = [128, 256, 480, 768, 1024] as const
export type CreativeThumbnailWidth = typeof CREATIVE_THUMBNAIL_WIDTHS[number]

export interface CreativeAssetRepresentation {
  path: string
  byteSize: number
  mimeType: string
  etag: string
}

const thumbnailWidths = new Set<number>(CREATIVE_THUMBNAIL_WIDTHS)
const thumbnailRequests = new Map<string, Promise<void>>()
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function validatedMime(bytes: Uint8Array, claimed: string) {
  let detected = ''
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) detected = 'image/png'
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = 'image/jpeg'
  else if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') detected = 'image/webp'
  if (!detected) throw new CreativeCoreError(400, 'INVALID_IMAGE_ASSET', 'Only valid PNG, JPEG, and WebP images are supported')
  if (MIME_EXTENSIONS[claimed] && claimed !== detected) throw new CreativeCoreError(400, 'IMAGE_MIME_MISMATCH', 'Image content does not match its MIME type')
  return detected
}

function imageDimensions(bytes: Uint8Array, mime: string) {
  const buffer = Buffer.from(bytes)
  if (mime === 'image/png' && bytes.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      }
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
  }
  if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      if (length < 2) break
      offset += 2 + length
    }
  }
  return { width: null, height: null }
}

function safePath(relativePath: string) {
  const root = creativeAssetRoot()
  const target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new CreativeCoreError(500, 'INVALID_ASSET_PATH', 'Creative asset path escaped its storage root')
  }
  return target
}

function localAssetPath(asset: AssetRecord) {
  if (!asset.storage_path) throw new CreativeCoreError(409, 'ASSET_NOT_LOCAL', 'Creative asset is not stored locally')
  return safePath(asset.storage_path)
}

function contentDigest(asset: AssetRecord) {
  if (!asset.sha256 || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new CreativeCoreError(500, 'INVALID_ASSET_DIGEST', 'Creative asset is missing a valid content digest')
  }
  return asset.sha256.toLowerCase()
}

function safeCacheAssetId(asset: AssetRecord) {
  if (!/^asset_[a-f0-9-]+$/i.test(asset.id)) {
    throw new CreativeCoreError(500, 'INVALID_ASSET_ID', 'Creative asset has an invalid identifier')
  }
  return asset.id.toLowerCase()
}

async function existingFile(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function thumbnailCachePath(asset: AssetRecord, width: CreativeThumbnailWidth) {
  const fileName = `${safeCacheAssetId(asset)}-${contentDigest(asset)}-w${width}-v${THUMBNAIL_VERSION}.webp`
  return safePath(join('.thumbnails', fileName))
}

function quotedEtag(value: string) {
  return `"${value}"`
}

export function parseCreativeThumbnailWidth(value: string | null): CreativeThumbnailWidth | null {
  if (value === null) return null
  if (!/^\d+$/.test(value)) {
    throw new CreativeCoreError(400, 'INVALID_THUMBNAIL_WIDTH', `Thumbnail width must be one of: ${CREATIVE_THUMBNAIL_WIDTHS.join(', ')}`)
  }
  const width = Number(value)
  if (!thumbnailWidths.has(width)) {
    throw new CreativeCoreError(400, 'INVALID_THUMBNAIL_WIDTH', `Thumbnail width must be one of: ${CREATIVE_THUMBNAIL_WIDTHS.join(', ')}`)
  }
  return width as CreativeThumbnailWidth
}

export function etagMatches(ifNoneMatch: string | null, etag: string) {
  if (!ifNoneMatch) return false
  return ifNoneMatch.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === '*' || value === etag || value.replace(/^W\//, '') === etag
  })
}

export async function creativeAssetOriginal(asset: AssetRecord): Promise<CreativeAssetRepresentation> {
  const path = localAssetPath(asset)
  const file = await stat(path)
  return {
    path,
    byteSize: file.size,
    mimeType: asset.mime_type,
    etag: quotedEtag(contentDigest(asset)),
  }
}

async function createThumbnail(asset: AssetRecord, width: CreativeThumbnailWidth, target: string) {
  if (await existingFile(target)) return
  await mkdir(safePath('.thumbnails'), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await sharp(localAssetPath(asset), { failOn: 'error', sequentialRead: true })
      .rotate()
      .resize({ width, withoutEnlargement: true, fit: 'inside' })
      .webp({ quality: THUMBNAIL_QUALITY, effort: 4 })
      .toFile(temporary)
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!await existingFile(target)) throw error
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function creativeAssetThumbnail(asset: AssetRecord, width: CreativeThumbnailWidth): Promise<CreativeAssetRepresentation> {
  const target = thumbnailCachePath(asset, width)
  let request = thumbnailRequests.get(target)
  if (!request) {
    request = createThumbnail(asset, width, target)
    thumbnailRequests.set(target, request)
    void request.finally(() => {
      if (thumbnailRequests.get(target) === request) thumbnailRequests.delete(target)
    }).catch(() => {})
  }
  await request
  const file = await stat(target)
  const digest = createHash('sha256')
    .update(`thumbnail:${THUMBNAIL_VERSION}:${contentDigest(asset)}:${width}:webp:${THUMBNAIL_QUALITY}`)
    .digest('hex')
  return {
    path: target,
    byteSize: file.size,
    mimeType: 'image/webp',
    etag: quotedEtag(digest),
  }
}

export function creativeAssetStream(representation: CreativeAssetRepresentation) {
  return Readable.toWeb(createReadStream(representation.path)) as ReadableStream<Uint8Array>
}

export async function storeCreativeAsset(input: {
  ownerId: string
  kind: AssetRecord['kind']
  bytes: Uint8Array
  mime: string
  originalName?: string | null
}) {
  if (!input.bytes.length || input.bytes.length > MAX_IMAGE_BYTES) throw new CreativeCoreError(413, 'INVALID_ASSET_SIZE', 'Creative image must be between 1 byte and 20 MB')
  const mime = validatedMime(input.bytes, input.mime.toLowerCase().replace('image/jpg', 'image/jpeg'))
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const existing = await findAssetByHash(input.ownerId, sha256, input.kind)
  if (existing) return existing

  const id = `asset_${randomUUID()}`
  const extension = MIME_EXTENSIONS[mime]
  const relativePath = join(input.kind, `${id}.${extension}`)
  const target = safePath(relativePath)
  await mkdir(resolve(creativeAssetRoot(), input.kind), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, input.bytes, { flag: 'wx' })
  await rename(temporary, target)
  const dimensions = imageDimensions(input.bytes, mime)
  try {
    return await createAssetRecord({
      id,
      owner_id: input.ownerId,
      kind: input.kind,
      original_name: input.originalName || null,
      mime_type: mime,
      byte_size: input.bytes.length,
      sha256,
      storage_path: relativePath.replace(/\\/g, '/'),
      external_url: null,
      width: dimensions.width,
      height: dimensions.height,
    })
  } catch (error) {
    await unlink(target).catch(() => {})
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      const raced = await findAssetByHash(input.ownerId, sha256, input.kind)
      if (raced) return raced
    }
    throw error
  }
}

export async function creativeAssetBytes(asset: AssetRecord) {
  return new Uint8Array(await readFile(localAssetPath(asset)))
}

export async function creativeAssetHasAlpha(asset: AssetRecord) {
  const { data, info } = await sharp(localAssetPath(asset), { failOn: 'error', sequentialRead: true })
    .rotate()
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = info.width * info.height
  const required = Math.max(1, Math.ceil(pixels * 0.001))
  let transparent = 0
  for (let offset = 3; offset < data.length; offset += info.channels) {
    if (data[offset] >= 250) continue
    transparent += 1
    if (transparent >= required) return true
  }
  return false
}

export async function creativeAssetFile(assetId: string) {
  const asset = await getAssetInternal(assetId)
  return { asset, bytes: await creativeAssetBytes(asset) }
}

export function parseDataImage(value: string) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=]+)$/i.exec(value)
  if (!match) return null
  return { mime: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), bytes: new Uint8Array(Buffer.from(match[2], 'base64')) }
}

export function assetIdFromUrl(value: string) {
  const match = /(?:^|\/)api\/v1\/creative\/assets\/(asset_[a-f0-9-]+)(?:\?.*)?$/i.exec(value)
  return match?.[1] ?? null
}

export function assetDownloadName(asset: AssetRecord) {
  const extension = extname(asset.storage_path || '') || `.${MIME_EXTENSIONS[asset.mime_type] || 'bin'}`
  const originalName = asset.original_name?.trim()
  if (!originalName) return `${asset.id}${extension}`
  const originalExtension = extname(originalName).toLowerCase()
  const validExtensions = asset.mime_type === 'image/jpeg' ? ['.jpg', '.jpeg'] : [extension.toLowerCase()]
  if (validExtensions.includes(originalExtension)) return originalName
  const basename = originalExtension ? originalName.slice(0, -originalExtension.length) : originalName
  return `${basename}${extension}`
}

function privateAddress(address: string) {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4) return true
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0
}

async function assertPublicResultUrl(url: URL) {
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new CreativeCoreError(502, 'INVALID_PROVIDER_RESULT', 'Image provider returned a private result URL')
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw new CreativeCoreError(502, 'INVALID_PROVIDER_RESULT', 'Image provider returned a private result URL')
  }
}

async function fetchCreativeResult(initialUrl: URL) {
  let url = initialUrl
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && process.env.NODE_ENV !== 'production')) {
      throw new CreativeCoreError(502, 'INVALID_PROVIDER_RESULT', 'Image provider returned an unsupported result URL')
    }
    if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(url.hostname)) await assertPublicResultUrl(url)
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new CreativeCoreError(502, 'INVALID_PROVIDER_REDIRECT', 'Image provider returned a redirect without a location')
      if (redirects === 5) throw new CreativeCoreError(502, 'TOO_MANY_PROVIDER_REDIRECTS', 'Image provider returned too many redirects')
      url = new URL(location, url)
      continue
    }
    return response
  }
  throw new CreativeCoreError(502, 'TOO_MANY_PROVIDER_REDIRECTS', 'Image provider returned too many redirects')
}

async function limitedResponseBytes(response: Response) {
  const length = Number(response.headers.get('content-length') || 0)
  if (length > MAX_IMAGE_BYTES) throw new CreativeCoreError(502, 'PROVIDER_RESULT_TOO_LARGE', 'Image provider result exceeded 20 MB')
  if (!response.body) throw new CreativeCoreError(502, 'EMPTY_PROVIDER_RESULT', 'Image provider returned an empty result')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new CreativeCoreError(502, 'PROVIDER_RESULT_TOO_LARGE', 'Image provider result exceeded 20 MB')
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks, total))
}

export async function storeCreativeResult(ownerId: string, value: string, index: number) {
  const data = parseDataImage(value)
  if (data) return storeCreativeAsset({ ownerId, kind: 'result', bytes: data.bytes, mime: data.mime, originalName: `result-${index + 1}` })

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CreativeCoreError(502, 'INVALID_PROVIDER_RESULT', 'Image provider returned an invalid result URL')
  }
  const response = await fetchCreativeResult(url)
  if (!response.ok) throw new CreativeCoreError(502, 'PROVIDER_RESULT_DOWNLOAD_FAILED', `Image result download failed with HTTP ${response.status}`)
  const bytes = await limitedResponseBytes(response)
  return storeCreativeAsset({
    ownerId,
    kind: 'result',
    bytes,
    mime: response.headers.get('content-type')?.split(';', 1)[0] || 'application/octet-stream',
    originalName: `result-${index + 1}`,
  })
}
