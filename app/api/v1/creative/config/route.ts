import { NextResponse } from 'next/server'
import { creativeCoreConfigured, creativeInProcessWorkerEnabled, creativePlannerConfig } from '@/lib/server/creative/config'
import { scheduleCreativeDrain } from '@/lib/server/creative/worker'
import { getStudioSession } from '@/lib/server/session'
import { manualApiKeyLoginEnabled, studioCapabilityGroups } from '@/lib/server/studio-config'
import { studioFeatureHealth } from '@/lib/server/creative/provider-credentials'

export async function GET() {
  if (creativeCoreConfigured() && creativeInProcessWorkerEnabled()) scheduleCreativeDrain()
  const session = await getStudioSession()
  const health = await studioFeatureHealth(session)
  const groups = studioCapabilityGroups()
  const featureStatus = Object.fromEntries((['image', 'text', 'video'] as const).map((capability) => {
    const missing = health.missingGroups[capability]
    return [capability, {
      configured: health.configured[capability],
      available: health.features[capability],
      degraded: health.degraded,
      group_id: groups[capability],
      ...(missing ? { code: 'STUDIO_GROUP_NOT_FOUND' } : {}),
    }]
  }))
  return NextResponse.json({
    enabled: creativeCoreConfigured(),
    database: 'postgresql',
    asset_storage: 'filesystem',
    planner_enabled: creativePlannerConfig().enabled,
    features: health.features,
    feature_status: featureStatus,
    api_key_login_enabled: manualApiKeyLoginEnabled(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
