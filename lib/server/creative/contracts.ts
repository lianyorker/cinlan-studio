import type { CreativeJob, CreativeJobStatus } from '@/lib/creative-types'
import type { CloudGeneration, GenStatus, Task } from '@/lib/types'

export function compatibleCreativeStatus(status: CreativeJobStatus): GenStatus {
  if (status === 'CREATED') return 'PENDING'
  if (status === 'ANALYZING' || status === 'READY' || status === 'QUEUED') return 'IN_QUEUE'
  if (status === 'RUNNING' || status === 'VALIDATING') return 'IN_PROGRESS'
  return status
}

export function creativeTaskContract(job: CreativeJob): Task & { task_id: string } {
  return {
    id: job.id,
    task_id: job.id,
    type: 'image',
    model: job.model,
    status: compatibleCreativeStatus(job.status),
    result_url: job.result_url || undefined,
    result_urls: job.result_urls,
    created_at: job.created_at,
    completed_at: job.completed_at || undefined,
    error: job.error_message || undefined,
    credits_used: 0,
  }
}

export function creativeGenerationContract(job: CreativeJob): CloudGeneration {
  const requestedCount = Number(job.parameters.count || 1)
  return {
    id: job.id,
    type: 'image',
    model: job.model,
    prompt: job.prompt,
    status: compatibleCreativeStatus(job.status),
    result_url: job.result_url || null,
    result_urls: job.result_urls,
    expected_count: Number.isFinite(requestedCount) ? Math.min(4, Math.max(1, requestedCount)) : 1,
    aspect_ratio: typeof job.parameters.aspect_ratio === 'string' ? job.parameters.aspect_ratio : null,
    thumbnail_url: null,
    credits_used: 0,
    created_at: job.created_at,
    error: job.error_message || null,
  }
}
