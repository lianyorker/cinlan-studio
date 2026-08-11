import { NextResponse } from 'next/server'
import { creativeCoreConfigured } from '@/lib/server/creative/config'
import { creativeOwnerContext } from '@/lib/server/creative/context'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { creativeJobDto, listCreativeJobs } from '@/lib/server/creative/repository'
import { submitCreativeImageJob } from '@/lib/server/creative/submission'

export async function POST(request: Request) {
  try {
    if (!creativeCoreConfigured()) throw new CreativeCoreError(503, 'CREATIVE_CORE_DISABLED', 'Creative Core database is not configured')
    return NextResponse.json(await submitCreativeImageJob(request))
  } catch (error) {
    return creativeErrorResponse(error)
  }
}

export async function GET(request: Request) {
  try {
    if (!creativeCoreConfigured()) return NextResponse.json({ jobs: [], pagination: { page: 1, pageSize: 24, totalCount: 0, totalPages: 0, hasMore: false } })
    const { owner } = await creativeOwnerContext()
    const url = new URL(request.url)
    const page = Math.max(1, Number(url.searchParams.get('page') || 1))
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 24)))
    const result = await listCreativeJobs(owner.id, { active: url.searchParams.get('active') === '1', page, pageSize })
    const jobs = await Promise.all(result.rows.map(creativeJobDto))
    return NextResponse.json({ jobs, pagination: { page, pageSize, totalCount: result.total, totalPages: Math.ceil(result.total / pageSize), hasMore: page * pageSize < result.total } })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
