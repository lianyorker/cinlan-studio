import { NextResponse } from 'next/server'
import { Sub2ApiError } from '../sub2api'
import { CreativeCoreError } from './errors'

export function creativeErrorResponse(error: unknown) {
  if (error instanceof CreativeCoreError || error instanceof Sub2ApiError) {
    return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
  }
  console.error('[creative-core] unhandled error', { message: error instanceof Error ? error.message : String(error) })
  return NextResponse.json({ message: 'Creative Core request failed', code: 'CREATIVE_CORE_ERROR' }, { status: 502 })
}
