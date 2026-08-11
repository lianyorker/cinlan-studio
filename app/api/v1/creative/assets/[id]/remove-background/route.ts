import { NextResponse } from 'next/server'
import { newRequestId } from '@/lib/server/sub2api'
import { creativeAssetHasAlpha } from '@/lib/server/creative/assets'
import { createBackgroundRemovalJob } from '@/lib/server/creative/background-removal-quota'
import { creativeSubmissionContext } from '@/lib/server/creative/context'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { backgroundRemovalQuota } from '@/lib/server/creative/background-removal-quota'
import { creativeJobDto, getAssetForOwner } from '@/lib/server/creative/repository'
import { scheduleCreativeDrain } from '@/lib/server/creative/worker'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const { owner, session } = await creativeSubmissionContext()
    const source = await getAssetForOwner(owner.id, id)
    if (await creativeAssetHasAlpha(source)) {
      const { quota } = await backgroundRemovalQuota(owner.id, session)
      return NextResponse.json({ job: null, quota, reused: true, already_transparent: true, asset_id: source.id }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      })
    }
    const body = await request.json().catch(() => ({})) as { idempotency_key?: unknown }
    const headerKey = request.headers.get('idempotency-key')?.trim()
    const bodyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
    const idempotencyKey = (headerKey || bodyKey || newRequestId('remove-bg')).slice(0, 200)
    const result = await createBackgroundRemovalJob({
      ownerId: owner.id,
      session,
      sourceAssetId: id,
      idempotencyKey,
    })
    scheduleCreativeDrain()
    return NextResponse.json({
      job: await creativeJobDto(result.job),
      quota: result.quota,
      reused: result.reused,
    }, {
      status: result.reused ? 200 : 202,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
