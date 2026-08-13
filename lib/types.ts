import type { ModelCapabilities } from './creative-types'

export interface ModelCreditConfig {
  cost?: number
  type?: string
  [k: string]: unknown
}

export interface Model {
  slug: string
  name: string
  type: 'image' | 'video' | 'text' | string
  creator: string
  creator_color?: string | null
  badge?: string | null
  credit_config?: ModelCreditConfig | null
  form_config?: Record<string, unknown> | null
  is_coming_soon?: boolean
  thumbnail_url?: string | null
  logo_url?: string | null
  capabilities?: ModelCapabilities
}

export interface Me {
  id: string | number
  email: string | null
  name?: string | null
  credits: number | null
  currency?: string
}

export type GenStatus = 'PENDING' | 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL_SUCCESS' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'FAILED' | 'EXPIRED'

export interface Task {
  id: string
  type: string
  model: string
  status: GenStatus
  result_url?: string
  result_urls?: string[]
  thumbnail_url?: string
  cover_url?: string
  duration?: number
  created_at?: number | string
  completed_at?: number | string
  expires_at?: number | string
  poll_url?: string
  error?: string
  credits_used: number
}

export interface GenerateResult {
  id: string
  task_id: string
  credits_used: number
  status?: GenStatus
  result_url?: string
  result_urls?: string[]
  thumbnail_url?: string
  cover_url?: string
  duration?: number
  created_at?: number | string
  completed_at?: number | string
  expires_at?: number | string
  poll_url?: string
  estimated_cost?: number | null
}

/** /api/v1/generations 항목 — 토큰 소유자의 클라우드 생성 기록 */
export interface CloudGeneration {
  id: string
  type: 'image' | 'video' | 'trending' | string
  model: string
  prompt: string | null
  status: GenStatus
  result_url: string | null
  result_urls?: string[]
  expected_count?: number
  aspect_ratio?: string | null
  thumbnail_url: string | null
  credits_used: number
    created_at: string
    error?: string | null
  }

export interface Paginated {
  page: number
  pageSize: number
  totalCount: number
  workCount?: number
  totalPages: number
  hasMore: boolean
}

export interface Example {
  id: string
  model: string
  prompt: string | null
  input_image: string | null
  input_video: string | null
  output: string
  output_type: 'image' | 'video'
  thumbnail: string | null
}
