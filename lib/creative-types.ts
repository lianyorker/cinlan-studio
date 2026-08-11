export const CREATIVE_JOB_STATUSES = [
  'CREATED',
  'ANALYZING',
  'READY',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
] as const

export type CreativeJobStatus = typeof CREATIVE_JOB_STATUSES[number]
export type CreativeJobMode = 'GENERATE' | 'EDIT'
export type CreativeAnalysisMode = 'standard' | 'deep'

export interface ModelCapabilities {
  text_to_image: boolean
  image_edit: boolean
  multi_image: boolean
  mask: boolean
  asynchronous: boolean
  max_reference_images: number
  max_outputs: number
  aspect_ratios: string[]
  qualities: string[]
  resolutions: string[]
}

export interface CreativePlan {
  schema_version: 1
  intent: string
  reference_roles: Array<{ index: number; role: 'primary' | 'identity' | 'style' | 'material' }>
  must_preserve: string[]
  allowed_changes: string[]
  composition: string
  output_checks: string[]
  planner: 'model' | 'deterministic'
}

export interface CreativeJob {
  id: string
  mode: CreativeJobMode
  status: CreativeJobStatus
  model: string
  prompt: string
  compiled_prompt?: string | null
  plan?: CreativePlan | null
  parameters: Record<string, unknown>
  provider_task_id?: string | null
  result_url?: string | null
  result_urls: string[]
  error_code?: string | null
  error_message?: string | null
  attempt_count: number
  created_at: string
  updated_at: string
  completed_at?: string | null
}

export interface CreativeEvent {
  id: number
  job_id: string
  type: string
  phase: string
  message_key: string
  payload: Record<string, unknown>
  created_at: string
}

export interface CreativeCoreConfig {
  enabled: boolean
  database: 'postgresql'
  asset_storage: 'filesystem'
  planner_enabled: boolean
  features: Record<'image' | 'text' | 'video', boolean>
  feature_status: Record<'image' | 'text' | 'video', {
    configured: boolean
    available: boolean
    degraded: boolean
    group_id: number | null
    code?: string
  }>
  api_key_login_enabled: boolean
}
