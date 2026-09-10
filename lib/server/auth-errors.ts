import { NextResponse } from 'next/server'
import { CreativeCoreError } from './creative/errors'
import { Sub2ApiError } from './sub2api'

function friendlySub2ApiMessage(error: Sub2ApiError) {
  const message = error.message || ''
  if (error.code === 'SUB2API_TIMEOUT' || /timed out|timeout/i.test(message)) {
    return 'Sub2API 响应超时，请稍后重试'
  }
  if (error.status >= 500 || /bad gateway|fetch failed|econnrefused|etimedout|network/i.test(message)) {
    return 'Sub2API 上游暂时不可用，请稍后重试'
  }
  return message
}

function inferredAuthError(error: Error) {
  const message = error.message || ''
  if (/CINLAN_SESSION_SECRET|NEXTAUTH_SECRET/i.test(message)) {
    return { status: 503, code: 'STUDIO_SESSION_UNAVAILABLE', message: 'Studio session storage is not configured' }
  }
  if (/group|分组/i.test(message)) return { status: 409, code: 'STUDIO_GROUP_NOT_FOUND', message }
  if (/credential|api key|key|密钥/i.test(message)) return { status: 503, code: 'STUDIO_CREDENTIAL_UNAVAILABLE', message }
  return null
}

export function authErrorResponse(error: unknown, fallbackMessage: string, fallbackCode: string) {
  if (error instanceof CreativeCoreError) {
    return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
  }
  if (error instanceof Sub2ApiError) {
    return NextResponse.json(
      { message: friendlySub2ApiMessage(error), code: error.code },
      { status: error.status }
    )
  }
  if (error instanceof Error) {
    const inferred = inferredAuthError(error)
    if (inferred) return NextResponse.json(inferred, { status: inferred.status })
  }
  console.error('[auth] unhandled auth error', { message: error instanceof Error ? error.message : String(error) })
  return NextResponse.json({ message: fallbackMessage, code: fallbackCode }, { status: 502 })
}
