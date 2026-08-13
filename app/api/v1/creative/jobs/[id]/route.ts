import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { creativeOwnerContext } from '@/lib/server/creative/context'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { creativeErrorResponse } from '@/lib/server/creative/http'
import { createCreativeJob, creativeJobDto, getJobForOwner, jobAssets, requestCreativeCancellation, softDeleteCreativeJob } from '@/lib/server/creative/repository'
import { abortInProcessCreativeJob, scheduleCreativeDrain } from '@/lib/server/creative/worker'
import { resolveStudioCredential } from '@/lib/server/creative/provider-credentials'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { owner } = await creativeOwnerContext()
    const { id } = await context.params
    return NextResponse.json(await creativeJobDto(await getJobForOwner(owner.id, id)))
  } catch (error) {
    return creativeErrorResponse(error)
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, owner } = await creativeOwnerContext()
    const { id } = await context.params
    const input = await request.json().catch(() => ({})) as { action?: string }
    if (input.action === 'retry') {
      const source = await getJobForOwner(owner.id, id)
      if (source.status !== 'FAILED' && source.status !== 'EXPIRED') {
        throw new CreativeCoreError(409, 'CREATIVE_JOB_NOT_RETRYABLE', 'Only failed or expired creative jobs can be retried')
      }
      const assets = await jobAssets(source.id)
      const providerCredential = await resolveStudioCredential(session, 'image', source.model)
      const parameters = {
        ...source.parameters,
        provider_credential_id: providerCredential.id || undefined,
        provider_group_id: providerCredential.groupId || undefined,
        provider_credential_rotation: providerCredential.rotationVersion,
        provider_credential_retry_count: 0,
        provider_credential_rejected_rotation: 0,
      }
      const retried = await createCreativeJob({
        ownerId: owner.id,
        mode: source.mode,
        model: source.model,
        prompt: source.prompt_original,
        parameters,
        idempotencyKey: `retry_${randomUUID()}`,
        inputAssetIds: assets.filter((asset) => asset.role === 'input').map((asset) => asset.id),
        maskAssetId: assets.find((asset) => asset.role === 'mask')?.id,
      })
      scheduleCreativeDrain()
      return NextResponse.json(await creativeJobDto(retried))
    }
    if (input.action !== 'cancel') return NextResponse.json({ message: 'Unsupported creative job action', code: 'INVALID_JOB_ACTION' }, { status: 400 })
    const job = await requestCreativeCancellation(owner.id, id)
    abortInProcessCreativeJob(id)
    return NextResponse.json(await creativeJobDto(job))
  } catch (error) {
    return creativeErrorResponse(error)
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { owner } = await creativeOwnerContext()
    const { id } = await context.params
    await softDeleteCreativeJob(owner.id, id)
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return creativeErrorResponse(error)
  }
}
