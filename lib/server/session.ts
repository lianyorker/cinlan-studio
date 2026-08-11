import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'

const COOKIE_NAME = 'cinlan_session'
const MAX_AGE = 60 * 60 * 24 * 30
const ephemeralSecret = randomBytes(32)

export interface StudioSession {
  accessToken?: string
  refreshToken?: string
  accessExpiresAt?: number
  apiKey?: string
  authMode: 'login' | 'api_key'
  user: {
    id?: number | string
    email?: string | null
    name?: string | null
    balance?: number | null
  }
}

function keyMaterial() {
  const configured = process.env.CINLAN_SESSION_SECRET || process.env.NEXTAUTH_SECRET
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('CINLAN_SESSION_SECRET must be configured in production')
  }
  return configured ? createHash('sha256').update(configured).digest() : ephemeralSecret
}

function cookieSameSite(): 'lax' | 'none' {
  return process.env.NODE_ENV === 'production' && process.env.CINLAN_EMBEDDED === 'true' ? 'none' : 'lax'
}

function cookieSecure() {
  return process.env.NODE_ENV === 'production' && process.env.CINLAN_COOKIE_SECURE !== 'false'
}

function seal(value: StudioSession) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

function unseal(value: string): StudioSession | null {
  try {
    const raw = Buffer.from(value, 'base64url')
    if (raw.length < 28) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), iv)
    decipher.setAuthTag(tag)
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    const session = JSON.parse(json) as StudioSession
    if (!session || (session.authMode !== 'login' && session.authMode !== 'api_key')) return null
    if (session.authMode === 'login') {
      return session.accessToken && session.user?.id !== undefined && session.user?.id !== null ? session : null
    }
    return typeof session.apiKey === 'string' && session.apiKey.length > 0 ? session : null
  } catch {
    return null
  }
}

export async function getStudioSession() {
  const jar = await cookies()
  const value = jar.get(COOKIE_NAME)?.value
  return value ? unseal(value) : null
}

export async function setStudioSession(session: StudioSession) {
  const jar = await cookies()
  jar.set(COOKIE_NAME, seal(session), {
    httpOnly: true,
    sameSite: cookieSameSite(),
    secure: cookieSecure(),
    path: '/',
    maxAge: MAX_AGE,
  })
}

export async function clearStudioSession() {
  const jar = await cookies()
  jar.set(COOKIE_NAME, '', { httpOnly: true, sameSite: cookieSameSite(), secure: cookieSecure(), path: '/', maxAge: 0 })
}
