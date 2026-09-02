import { NextResponse } from 'next/server'
import { getTask, requireGenerationSession } from '@/lib/server/generation'
import { Sub2ApiError } from '@/lib/server/sub2api'
import { creativeCoreConfigured } from '@/lib/server/creative/config'
import { creativeTaskContract } from '@/lib/server/creative/contracts'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { creativeOwnerIdentity } from '@/lib/server/creative/identity'
import { creativeJobDto, findJobForOwner } from '@/lib/server/creative/repository'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const session = await requireGenerationSession()
    const requestedType = new URL(request.url).searchParams.get('type')
    const type = requestedType === 'image' || requestedType === 'video' ? requestedType : undefined
    if (type !== 'video' && creativeCoreConfigured()) {
      const job = await findJobForOwner(creativeOwnerIdentity(session).id, id)
      if (job) return NextResponse.json(creativeTaskContract(await creativeJobDto(job)))
    }
    return NextResponse.json(await getTask(id, session, undefined, type))
  } catch (error) {
    if (error instanceof CreativeCoreError) return creativeErrorResponse(error)
    if (error instanceof Sub2ApiError) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
    return NextResponse.json({ message: error instanceof Error ? error.message : '任务查询失败' }, { status: 502 })
  }
}
