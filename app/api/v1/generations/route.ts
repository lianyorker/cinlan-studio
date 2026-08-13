import { NextResponse } from 'next/server'
import { creativeCoreConfigured } from '@/lib/server/creative/config'
import { creativeGenerationContract } from '@/lib/server/creative/contracts'
import { creativeOwnerContext } from '@/lib/server/creative/context'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { creativeJobDto, listCreativeJobs } from '@/lib/server/creative/repository'

export async function GET(request: Request) {
  if (!creativeCoreConfigured()) {
    return NextResponse.json({ generations: [], pagination: { page: 1, pageSize: 24, totalCount: 0, workCount: 0, totalPages: 0, hasMore: false } })
  }
  try {
    const url = new URL(request.url)
    const page = Math.max(1, Number(url.searchParams.get('page') || 1))
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 24)))
    if (url.searchParams.get('type') === 'video') {
      return NextResponse.json({ generations: [], pagination: { page, pageSize, totalCount: 0, workCount: 0, totalPages: 0, hasMore: false } })
    }
    const { owner } = await creativeOwnerContext()
    const result = await listCreativeJobs(owner.id, { page, pageSize })
    const jobs = await Promise.all(result.rows.map(creativeJobDto))
    return NextResponse.json({
      generations: jobs.map(creativeGenerationContract),
      pagination: {
        page,
        pageSize,
        totalCount: result.total,
        workCount: result.workCount,
        totalPages: Math.ceil(result.total / pageSize),
        hasMore: page * pageSize < result.total,
      },
    })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
