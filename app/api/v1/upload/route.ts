import { NextResponse } from 'next/server'
import { requireGenerationSession } from '@/lib/server/generation'
import { Sub2ApiError } from '@/lib/server/sub2api'
import { storeCreativeAsset } from '@/lib/server/creative/assets'
import { creativeCoreConfigured } from '@/lib/server/creative/config'
import { creativeSubmissionContext } from '@/lib/server/creative/context'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_VIDEO_BYTES = 32 * 1024 * 1024

export async function POST(request: Request) {
  try {
    const session = await requireGenerationSession()
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ message: '缺少上传文件' }, { status: 400 })
    const max = file.type.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    if (file.size <= 0 || file.size > max) return NextResponse.json({ message: '文件大小超出限制' }, { status: 413 })
    const bytes = Buffer.from(await file.arrayBuffer())

    if (creativeCoreConfigured() && file.type.startsWith('image/')) {
      const { owner } = await creativeSubmissionContext(session)
      const asset = await storeCreativeAsset({
        ownerId: owner.id,
        kind: 'reference',
        bytes,
        mime: file.type,
        originalName: file.name,
      })
      return NextResponse.json({
        assetId: asset.id,
        publicUrl: `/api/v1/creative/assets/${asset.id}`,
        name: file.name,
        size: asset.byte_size,
        contentType: asset.mime_type,
      })
    }

    const publicUrl = `data:${file.type || 'application/octet-stream'};base64,${bytes.toString('base64')}`
    return NextResponse.json({ publicUrl, name: file.name, size: file.size, contentType: file.type })
  } catch (error) {
    if (error instanceof CreativeCoreError || error instanceof Sub2ApiError) return creativeErrorResponse(error)
    return NextResponse.json({ message: error instanceof Error ? error.message : '上传失败' }, { status: 502 })
  }
}
