import { NextResponse } from 'next/server'
import { authErrorResponse } from '@/lib/server/auth-errors'
import { persistEmbeddedSession } from '@/lib/server/studio-auth'

function configuredOrigins() {
  return (process.env.CINLAN_ALLOWED_ORIGINS || '').split(/\s+/).filter(Boolean)
}

function normalizedOrigin(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

export async function POST(request: Request) {
  try {
    const signal = AbortSignal.timeout(15_000)
    const body = await request.json() as { token?: unknown; user_id?: unknown; src_host?: unknown }
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    const expectedUserId = body.user_id === undefined || body.user_id === null ? '' : String(body.user_id).trim()
    const sourceOrigin = normalizedOrigin(body.src_host)
    if (!token || token.length > 8192) {
      return NextResponse.json({ message: 'Sub2API 嵌入令牌无效', code: 'INVALID_EMBED_TOKEN' }, { status: 400 })
    }
    if (body.src_host && !sourceOrigin) {
      return NextResponse.json({ message: 'Sub2API 嵌入来源无效', code: 'INVALID_EMBED_SOURCE' }, { status: 400 })
    }
    const allowedOrigins = configuredOrigins()
    if (sourceOrigin && allowedOrigins.length && !allowedOrigins.includes(sourceOrigin)) {
      return NextResponse.json({ message: 'Sub2API 嵌入来源未授权', code: 'EMBED_SOURCE_NOT_ALLOWED' }, { status: 403 })
    }

    const session = await persistEmbeddedSession(token, expectedUserId || undefined, signal)
    return NextResponse.json({
      connected: true,
      user: {
        id: session.user.id,
        email: session.user.email ?? null,
        name: session.user.name ?? null,
        balance: session.user.balance ?? null,
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/不匹配|mismatch/i.test(message)) {
      return NextResponse.json({ message, code: 'EMBED_USER_MISMATCH' }, { status: 403 })
    }
    return authErrorResponse(error, 'Sub2API 嵌入登录失败，请稍后重试', 'EMBED_AUTH_FAILED')
  }
}
