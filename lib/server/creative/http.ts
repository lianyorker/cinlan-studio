import { NextResponse } from 'next/server'
import { Sub2ApiError } from '../sub2api'
import { CreativeCoreError } from './errors'

function sanitizeUpstreamMessage(error: Sub2ApiError) {
  if (error.status >= 500) return 'Sub2API 上游暂时不可用，请稍后重试'
  if (error.code === 'SUB2API_TIMEOUT') return 'Sub2API 响应超时，请稍后重试'
  return error.message
}

export function creativeErrorResponse(error: unknown) {
  if (error instanceof CreativeCoreError) {
    return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
  }
  if (error instanceof Sub2ApiError) {
    return NextResponse.json({ message: sanitizeUpstreamMessage(error), code: error.code }, { status: error.status })
  }
  console.error('[creative-core] unhandled error', { message: error instanceof Error ? error.message : String(error) })
  return NextResponse.json({ message: 'Creative Core request failed', code: 'CREATIVE_CORE_ERROR' }, { status: 502 })
}
