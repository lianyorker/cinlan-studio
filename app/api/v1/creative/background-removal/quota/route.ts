import { NextResponse } from 'next/server'
import { backgroundRemovalQuota } from '@/lib/server/creative/background-removal-quota'
import { creativeSubmissionContext } from '@/lib/server/creative/context'
import { creativeErrorResponse } from '@/lib/server/creative/http'

export async function GET() {
  try {
    const { owner, session } = await creativeSubmissionContext()
    const { quota } = await backgroundRemovalQuota(owner.id, session)
    return NextResponse.json(quota, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
