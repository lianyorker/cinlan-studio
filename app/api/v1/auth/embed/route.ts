import { NextResponse } from 'next/server'
import { persistEmbeddedSession } from '@/lib/server/studio-auth'
import { Sub2ApiError } from '@/lib/server/sub2api'

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

    const session = await persistEmbeddedSession(token, expectedUserId || undefined)
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
    if (error instanceof Sub2ApiError) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : 'Sub2API 嵌入登录失败'
    const status = /令牌不匹配/.test(message) ? 403 : 502
    return NextResponse.json({ message, code: status === 403 ? 'EMBED_USER_MISMATCH' : 'EMBED_AUTH_FAILED' }, { status })
  }
}
