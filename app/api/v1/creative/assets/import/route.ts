import { NextResponse } from 'next/server'
import { storeCreativeResult } from '@/lib/server/creative/assets'
import { creativeSubmissionContext } from '@/lib/server/creative/context'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { url?: unknown }
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url || url.length > 4096 || !/^https?:\/\//i.test(url)) {
      throw new CreativeCoreError(400, 'INVALID_CREATIVE_IMPORT_URL', 'Only a public HTTP(S) image URL can be imported')
    }
    const { owner } = await creativeSubmissionContext()
    const asset = await storeCreativeResult(owner.id, url, 0)
    return NextResponse.json({
      assetId: asset.id,
      publicUrl: `/api/v1/creative/assets/${asset.id}`,
      name: asset.original_name,
      size: asset.byte_size,
      contentType: asset.mime_type,
    }, { status: 201, headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
