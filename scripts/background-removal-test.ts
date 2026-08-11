import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { normalizeAliyunInput } from '../lib/server/creative/aliyun-background-removal'
import { creativeAssetHasAlpha } from '../lib/server/creative/assets'
import { backgroundRemovalLimit } from '../lib/server/creative/background-removal-quota'
import type { AssetRecord } from '../lib/server/creative/repository'

function asset(storagePath: string): AssetRecord {
  return {
    id: 'asset_00000000-0000-0000-0000-000000000000',
    owner_id: 'owner_test',
    kind: 'result',
    original_name: storagePath,
    mime_type: 'image/png',
    byte_size: 1,
    sha256: '0'.repeat(64),
    storage_path: storagePath,
    external_url: null,
    width: 64,
    height: 64,
    created_at: new Date(),
  }
}

async function main() {
  assert.equal(backgroundRemovalLimit(null), 5)
  assert.equal(backgroundRemovalLimit(0), 5)
  assert.equal(backgroundRemovalLimit(500), 5)
  assert.equal(backgroundRemovalLimit(500.01), 20)
  assert.equal(backgroundRemovalLimit(Number.NaN), 5)

  const source = await sharp({
    create: {
      width: 2400,
      height: 1200,
      channels: 4,
      background: { r: 32, g: 96, b: 160, alpha: 1 },
    },
  }).png().toBuffer()
  const normalized = await normalizeAliyunInput(source)
  const metadata = await sharp(normalized).metadata()
  assert.equal(metadata.format, 'jpeg')
  assert.ok(Math.max(metadata.width || 0, metadata.height || 0) <= 1999)
  assert.ok(normalized.length <= 3 * 1024 * 1024)

  const root = await mkdtemp(join(tmpdir(), 'cinlan-background-removal-'))
  const previousRoot = process.env.CREATIVE_ASSET_STORAGE_DIR
  process.env.CREATIVE_ASSET_STORAGE_DIR = root
  try {
    const opaqueName = 'opaque-rgba.png'
    const transparentName = 'transparent.png'
    await writeFile(join(root, opaqueName), await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
    }).png().toBuffer())
    await writeFile(join(root, transparentName), await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 30, g: 90, b: 180, alpha: 0 } },
    }).png().toBuffer())
    assert.equal(await creativeAssetHasAlpha(asset(opaqueName)), false)
    assert.equal(await creativeAssetHasAlpha(asset(transparentName)), true)
  } finally {
    if (previousRoot === undefined) delete process.env.CREATIVE_ASSET_STORAGE_DIR
    else process.env.CREATIVE_ASSET_STORAGE_DIR = previousRoot
    await rm(root, { recursive: true, force: true })
  }

  console.log('Background removal test passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
