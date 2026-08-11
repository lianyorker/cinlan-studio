import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { thumbUrl } from '../lib/api'
import {
  creativeAssetOriginal,
  creativeAssetStream,
  creativeAssetThumbnail,
  etagMatches,
  parseCreativeThumbnailWidth,
} from '../lib/server/creative/assets'
import { CreativeCoreError } from '../lib/server/creative/errors'
import type { AssetRecord } from '../lib/server/creative/repository'

function assetRecord(input: { id: string; storagePath: string; bytes: Buffer; width: number; height: number }): AssetRecord {
  return {
    id: input.id,
    owner_id: 'owner_test',
    kind: 'result',
    original_name: 'test-source.png',
    mime_type: 'image/png',
    byte_size: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    storage_path: input.storagePath,
    external_url: null,
    width: input.width,
    height: input.height,
    created_at: new Date(),
  }
}

async function main() {
  const previousRoot = process.env.CREATIVE_ASSET_STORAGE_DIR
  const root = await mkdtemp(join(tmpdir(), 'cinlan-assets-'))
  process.env.CREATIVE_ASSET_STORAGE_DIR = root

  try {
  assert.equal(parseCreativeThumbnailWidth(null), null)
  assert.equal(parseCreativeThumbnailWidth('480'), 480)
  assert.equal(thumbUrl('/api/v1/creative/assets/asset_1234abcd?w=128', 480), '/api/v1/creative/assets/asset_1234abcd?w=480')
  assert.equal(thumbUrl('https://cdn.example.com/result.png', 480), 'https://cdn.example.com/result.png')
  for (const value of ['', '0', '479', '2048', '../480']) {
    assert.throws(
      () => parseCreativeThumbnailWidth(value),
      (error) => error instanceof CreativeCoreError && error.status === 400 && error.code === 'INVALID_THUMBNAIL_WIDTH'
    )
  }

  const width = 1200
  const height = 1200
  const sourceBytes = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png({ compressionLevel: 6 }).toBuffer()
  const id = `asset_${randomUUID()}`
  const storagePath = `result/${id}.png`
  await mkdir(join(root, 'result'), { recursive: true })
  await writeFile(join(root, storagePath), sourceBytes)
  const asset = assetRecord({ id, storagePath, bytes: sourceBytes, width, height })

  const thumbnails = await Promise.all(
    Array.from({ length: 12 }, () => creativeAssetThumbnail(asset, 480))
  )
  const thumbnail = thumbnails[0]
  assert.ok(thumbnails.every((item) => item.path === thumbnail.path))
  assert.equal(thumbnail.mimeType, 'image/webp')
  assert.ok(thumbnail.byteSize < 200 * 1024, `Expected a thumbnail below 200 KB, received ${thumbnail.byteSize}`)
  assert.ok(thumbnail.byteSize < sourceBytes.length)
  const metadata = await sharp(await readFile(thumbnail.path)).metadata()
  assert.equal(metadata.format, 'webp')
  assert.ok((metadata.width ?? Infinity) <= 480)
  assert.equal(etagMatches(thumbnail.etag, thumbnail.etag), true)
  assert.equal(etagMatches(`W/${thumbnail.etag}`, thumbnail.etag), true)
  assert.equal(etagMatches('"different"', thumbnail.etag), false)

  const cacheEntries = await readdir(join(root, '.thumbnails'))
  assert.equal(cacheEntries.filter((name) => name.endsWith('.webp')).length, 1)
  assert.equal(cacheEntries.filter((name) => name.endsWith('.tmp')).length, 0)

  const original = await creativeAssetOriginal(asset)
  assert.equal(original.byteSize, sourceBytes.length)
  assert.equal(original.mimeType, 'image/png')
  const streamed = Buffer.from(await new Response(creativeAssetStream(original)).arrayBuffer())
  assert.equal(createHash('sha256').update(streamed).digest('hex'), asset.sha256)
  await assert.rejects(
    creativeAssetOriginal({ ...asset, storage_path: '../outside.png' }),
    (error) => error instanceof CreativeCoreError && error.code === 'INVALID_ASSET_PATH'
  )

  const smallBytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#ffffff' },
  }).png().toBuffer()
  const smallId = `asset_${randomUUID()}`
  const smallStoragePath = `result/${smallId}.png`
  await writeFile(join(root, smallStoragePath), smallBytes)
  const smallAsset = assetRecord({ id: smallId, storagePath: smallStoragePath, bytes: smallBytes, width: 64, height: 48 })
  const smallThumbnail = await creativeAssetThumbnail(smallAsset, 480)
  const smallMetadata = await sharp(await readFile(smallThumbnail.path)).metadata()
  assert.equal(smallMetadata.width, 64)
  assert.equal(smallMetadata.height, 48)

  console.log(JSON.stringify({
    sourceBytes: sourceBytes.length,
    thumbnailBytes: thumbnail.byteSize,
    thumbnailWidth: metadata.width,
    concurrentRequests: thumbnails.length,
  }))
  } finally {
    if (previousRoot === undefined) delete process.env.CREATIVE_ASSET_STORAGE_DIR
    else process.env.CREATIVE_ASSET_STORAGE_DIR = previousRoot
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
