import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { StudioSession } from '../session'
import { CreativeCoreError } from './errors'

function secret() {
  const value = process.env.CINLAN_SESSION_SECRET || process.env.NEXTAUTH_SECRET
  if (!value) throw new CreativeCoreError(503, 'CREATIVE_SECRET_MISSING', 'CINLAN_SESSION_SECRET is required for Creative Core')
  return createHash('sha256').update(value).digest()
}

export function creativeOwnerIdentity(session: StudioSession) {
  const hasUser = session.user.id !== undefined && session.user.id !== null
  if (!hasUser && !session.apiKey) throw new CreativeCoreError(401, 'AUTH_REQUIRED', 'Studio session has no user identity or API Key')
  const externalKey = hasUser
    ? `user:${session.user.id}`
    : `api_key:${createHmac('sha256', secret()).update(session.apiKey!).digest('hex')}`
  return {
    id: `owner_${createHash('sha256').update(externalKey).digest('hex').slice(0, 40)}`,
    kind: hasUser ? 'user' : 'api_key',
    displayName: session.user.name || session.user.email || null,
  }
}

export function sealCreativeCredential(apiKey: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secret(), iv)
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function openCreativeCredential(value: string) {
  try {
    const raw = Buffer.from(value, 'base64url')
    if (raw.length < 29) throw new Error('Credential payload is invalid')
    const decipher = createDecipheriv('aes-256-gcm', secret(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    throw new CreativeCoreError(503, 'CREATIVE_CREDENTIAL_UNAVAILABLE', 'Creative Core credential could not be decrypted')
  }
}
