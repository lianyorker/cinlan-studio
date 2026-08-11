import type { CreativeJob } from './creative-types'

export interface BackgroundRemovalQuota {
  usage_date: string
  limit: number
  used: number
  remaining: number
  resets_at: string
}

export interface BackgroundRemovalSubmission {
  job: CreativeJob | null
  quota: BackgroundRemovalQuota
  reused: boolean
}
