import { creativeOwnerContext } from '@/lib/server/creative/context'
import {
  assetDownloadName,
  creativeAssetOriginal,
  creativeAssetStream,
  creativeAssetThumbnail,
  etagMatches,
  parseCreativeThumbnailWidth,
} from '@/lib/server/creative/assets'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { getAssetForOwner, softDeleteAsset } from '@/lib/server/creative/repository'

export const runtime = 'nodejs'

function responseName(name: string, width: number | null) {
  if (width === null) return name
  const extension = name.lastIndexOf('.')
  const base = extension > 0 ? name.slice(0, extension) : name
  return `${base}-${width}.webp`
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { owner } = await creativeOwnerContext()
    const { id } = await context.params
    const asset = await getAssetForOwner(owner.id, id)
    const width = parseCreativeThumbnailWidth(new URL(request.url).searchParams.get('w'))
    const representation = width === null
      ? await creativeAssetOriginal(asset)
      : await creativeAssetThumbnail(asset, width)
    const name = responseName(assetDownloadName(asset), width).replace(/["\\\r\n]/g, '_')
    const fallbackName = name.replace(/[^\x20-\x7e]/g, '_')
    const headers = new Headers({
      'Content-Type': representation.mimeType,
      'Content-Disposition': `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
      'ETag': representation.etag,
      'Vary': 'Cookie, Authorization',
      'X-Content-Type-Options': 'nosniff',
    })
    if (etagMatches(request.headers.get('if-none-match'), representation.etag)) {
      return new Response(null, { status: 304, headers })
    }
    headers.set('Content-Length', String(representation.byteSize))
    return new Response(creativeAssetStream(representation), { headers })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { owner } = await creativeOwnerContext()
    const { id } = await context.params
    await softDeleteAsset(owner.id, id)
    return new Response(null, { status: 204 })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
