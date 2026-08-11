import { createHash } from 'node:crypto'
import type { StudioSession } from '../session'
import { Sub2ApiError, sub2apiFetch } from '../sub2api'
import {
  manualApiKeyLoginEnabled,
  studioCapabilityGroups,
  studioFeatureFlags,
  studioGroupFor,
  studioInstallationId,
  type StudioCapability,
  type StudioFeatureFlags,
} from '../studio-config'
import { creativeCoreConfigured } from './config'
import { creativeQuery, creativeTransaction } from './db'
import { CreativeCoreError } from './errors'
import { creativeOwnerIdentity, openCreativeCredential, sealCreativeCredential } from './identity'
import { upsertCreativeOwner } from './repository'

interface Sub2Group {
  id?: number
  name?: string
  status?: string
}

interface Sub2Key {
  id?: number
  key?: string
  name?: string
  status?: string
  group_id?: number | null
}

interface CredentialRecord {
  id: string
  owner_id: string
  provider: string
  group_id: string | number
  remote_key_id: string | number | null
  encrypted_api_key: string | null
  status: 'provisioning' | 'active' | 'invalid' | 'orphaned_group' | 'reauth_required' | 'revoked'
  rotation_version: number
}

interface IdentityRecord {
  encrypted_access_token: string
  encrypted_refresh_token: string | null
  access_expires_at: Date | null
  status: 'active' | 'reauth_required' | 'revoked'
}

export interface StudioProviderCredential {
  id: string | null
  ownerId: string
  groupId: number | null
  remoteKeyId: number | null
  rotationVersion: number
  apiKey: string
  managed: boolean
}

export interface StudioFeatureHealth {
  features: StudioFeatureFlags
  configured: StudioFeatureFlags
  degraded: boolean
  missingGroups: Partial<Record<StudioCapability, number>>
}

declare global {
  // eslint-disable-next-line no-var
  var __cinlanStudioGroupCache: Map<string, { expiresAt: number; groups: Sub2Group[] }> | undefined
}

function groupCache() {
  globalThis.__cinlanStudioGroupCache ??= new Map()
  return globalThis.__cinlanStudioGroupCache
}

function unwrapList<T>(value: unknown, depth = 0): T[] {
  if (Array.isArray(value)) return value as T[]
  if (!value || typeof value !== 'object' || depth > 3) return []
  const object = value as Record<string, unknown>
  for (const key of ['items', 'data', 'results', 'list']) {
    const nested = object[key]
    const result = unwrapList<T>(nested, depth + 1)
    if (result.length || Array.isArray(nested)) return result
  }
  return []
}

function credentialId(ownerId: string, groupId: number) {
  return `credential_${createHash('sha256').update(`sub2api:${ownerId}:${groupId}`).digest('hex').slice(0, 40)}`
}

function managedKeyName(ownerId: string, groupId: number) {
  const owner = createHash('sha256').update(ownerId).digest('hex').slice(0, 10)
  return `Cinlan Studio Managed/${studioInstallationId()}/${owner}/${groupId}`.slice(0, 100)
}

function groupCacheKey(session: StudioSession) {
  return createHash('sha256').update(`${session.user.id}:${session.accessToken || ''}`).digest('hex')
}

async function availableGroups(session: StudioSession, force = false) {
  if (session.authMode !== 'login' || !session.accessToken) {
    throw new CreativeCoreError(401, 'CREDENTIAL_REAUTH_REQUIRED', 'A Sub2API account login is required')
  }
  const key = groupCacheKey(session)
  const cached = groupCache().get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.groups
  const response = await sub2apiFetch<unknown>('/api/v1/groups/available', { accessToken: session.accessToken })
  const groups = unwrapList<Sub2Group>(response)
  groupCache().set(key, { expiresAt: Date.now() + 30_000, groups })
  return groups
}

async function markGroupOrphaned(ownerId: string, groupId: number) {
  if (!creativeCoreConfigured()) return
  await creativeQuery(
    `UPDATE studio_provider_credentials
        SET status = 'orphaned_group', last_error_code = 'STUDIO_GROUP_NOT_FOUND', updated_at = now()
      WHERE owner_id = $1 AND provider = 'sub2api' AND group_id = $2`,
    [ownerId, groupId]
  )
}

async function ensureGroupAvailable(session: StudioSession, ownerId: string, groupId: number, force = false) {
  const groups = await availableGroups(session, force)
  const group = groups.find((candidate) => Number(candidate.id) === groupId)
  if (!group) {
    await markGroupOrphaned(ownerId, groupId)
    throw new CreativeCoreError(409, 'STUDIO_GROUP_NOT_FOUND', 'The configured Studio group no longer exists')
  }
  return group
}

async function credentialRecord(ownerId: string, groupId: number) {
  const result = await creativeQuery<CredentialRecord>(
    `SELECT * FROM studio_provider_credentials
      WHERE owner_id = $1 AND provider = 'sub2api' AND group_id = $2`,
    [ownerId, groupId]
  )
  return result.rows[0] ?? null
}

function resolvedCredential(record: CredentialRecord): StudioProviderCredential {
  if (!record.encrypted_api_key || record.status !== 'active') {
    throw new CreativeCoreError(503, 'STUDIO_CREDENTIAL_UNAVAILABLE', 'Studio provider credential is unavailable')
  }
  return {
    id: record.id,
    ownerId: record.owner_id,
    groupId: Number(record.group_id),
    remoteKeyId: record.remote_key_id === null ? null : Number(record.remote_key_id),
    rotationVersion: Number(record.rotation_version),
    apiKey: openCreativeCredential(record.encrypted_api_key),
    managed: true,
  }
}

async function createManagedCredential(session: StudioSession, ownerId: string, groupId: number, rejected?: StudioProviderCredential) {
  if (!session.accessToken) throw new CreativeCoreError(401, 'CREDENTIAL_REAUTH_REQUIRED', 'Please sign in again to restore the Studio credential')
  await ensureGroupAvailable(session, ownerId, groupId, true)
  return creativeTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`studio-credential:${ownerId}:${groupId}`])
    const currentResult = await client.query<CredentialRecord>(
      `SELECT * FROM studio_provider_credentials
        WHERE owner_id = $1 AND provider = 'sub2api' AND group_id = $2
        FOR UPDATE`,
      [ownerId, groupId]
    )
    const current = currentResult.rows[0]
    if (current?.status === 'active' && current.encrypted_api_key) {
      if (!rejected || Number(current.rotation_version) !== rejected.rotationVersion) return resolvedCredential(current)
    }
    const nextVersion = Math.max(Number(current?.rotation_version || 0) + 1, 1)
    const id = current?.id || credentialId(ownerId, groupId)
    await client.query(
      `INSERT INTO studio_provider_credentials(id, owner_id, provider, group_id, status, rotation_version, last_error_code)
       VALUES($1,$2,'sub2api',$3,'provisioning',$4,NULL)
       ON CONFLICT(owner_id, provider, group_id) DO UPDATE
         SET status = 'provisioning', rotation_version = $4, last_error_code = NULL, updated_at = now()`,
      [id, ownerId, groupId, nextVersion]
    )
    const created = await sub2apiFetch<Sub2Key>('/api/v1/keys', {
      accessToken: session.accessToken,
      method: 'POST',
      headers: { 'Idempotency-Key': `studio-credential-${id}-v${nextVersion}` },
      body: JSON.stringify({ name: managedKeyName(ownerId, groupId), group_id: groupId }),
    })
    if (!created.key || !created.id) {
      throw new CreativeCoreError(502, 'STUDIO_CREDENTIAL_UNAVAILABLE', 'Sub2API did not return the created Studio credential')
    }
    const saved = await client.query<CredentialRecord>(
      `UPDATE studio_provider_credentials
          SET remote_key_id = $2,
              encrypted_api_key = $3,
              status = 'active',
              last_verified_at = now(),
              last_error_code = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, created.id, sealCreativeCredential(created.key)]
    )
    return resolvedCredential(saved.rows[0])
  })
}

export async function persistStudioIdentitySession(session: StudioSession) {
  if (!creativeCoreConfigured() || session.authMode !== 'login' || !session.accessToken) return
  const owner = creativeOwnerIdentity(session)
  await upsertCreativeOwner(owner)
  await creativeQuery(
    `INSERT INTO studio_identity_sessions(owner_id, encrypted_access_token, encrypted_refresh_token, access_expires_at, status)
     VALUES($1,$2,$3,$4,'active')
     ON CONFLICT(owner_id) DO UPDATE
       SET encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, studio_identity_sessions.encrypted_refresh_token),
           access_expires_at = EXCLUDED.access_expires_at,
           status = 'active',
           updated_at = now()`,
    [
      owner.id,
      sealCreativeCredential(session.accessToken),
      session.refreshToken ? sealCreativeCredential(session.refreshToken) : null,
      session.accessExpiresAt ? new Date(session.accessExpiresAt) : null,
    ]
  )
}

export async function revokeStudioIdentitySession(session: StudioSession) {
  if (!creativeCoreConfigured() || session.authMode !== 'login') return
  const owner = creativeOwnerIdentity(session)
  await creativeQuery(
    `UPDATE studio_identity_sessions SET status = 'revoked', updated_at = now() WHERE owner_id = $1`,
    [owner.id]
  )
}

async function storedIdentitySession(ownerId: string): Promise<StudioSession> {
  const result = await creativeQuery<IdentityRecord>(
    `SELECT encrypted_access_token, encrypted_refresh_token, access_expires_at, status
       FROM studio_identity_sessions WHERE owner_id = $1`,
    [ownerId]
  )
  const identity = result.rows[0]
  if (!identity || identity.status !== 'active') {
    throw new CreativeCoreError(401, 'CREDENTIAL_REAUTH_REQUIRED', 'Please sign in again to restore the Studio credential')
  }
  let accessToken = openCreativeCredential(identity.encrypted_access_token)
  let refreshToken = identity.encrypted_refresh_token ? openCreativeCredential(identity.encrypted_refresh_token) : undefined
  let accessExpiresAt = identity.access_expires_at?.getTime()
  if (accessExpiresAt && accessExpiresAt <= Date.now() + 30_000) {
    if (!refreshToken) {
      await creativeQuery(`UPDATE studio_identity_sessions SET status = 'reauth_required', updated_at = now() WHERE owner_id = $1`, [ownerId])
      throw new CreativeCoreError(401, 'CREDENTIAL_REAUTH_REQUIRED', 'Please sign in again to restore the Studio credential')
    }
    try {
      const refreshed = await sub2apiFetch<{ access_token?: string; refresh_token?: string; expires_in?: number }>('/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!refreshed.access_token) throw new Error('Sub2API did not return a refreshed access token')
      accessToken = refreshed.access_token
      refreshToken = refreshed.refresh_token ?? refreshToken
      accessExpiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined
      await creativeQuery(
        `UPDATE studio_identity_sessions
            SET encrypted_access_token = $2,
                encrypted_refresh_token = $3,
                access_expires_at = $4,
                status = 'active',
                updated_at = now()
          WHERE owner_id = $1`,
        [ownerId, sealCreativeCredential(accessToken), refreshToken ? sealCreativeCredential(refreshToken) : null, accessExpiresAt ? new Date(accessExpiresAt) : null]
      )
    } catch {
      await creativeQuery(`UPDATE studio_identity_sessions SET status = 'reauth_required', updated_at = now() WHERE owner_id = $1`, [ownerId])
      throw new CreativeCoreError(401, 'CREDENTIAL_REAUTH_REQUIRED', 'Please sign in again to restore the Studio credential')
    }
  }
  return { accessToken, refreshToken, accessExpiresAt, authMode: 'login', user: { id: ownerId } }
}

export async function studioFeatureHealth(session?: StudioSession | null): Promise<StudioFeatureHealth> {
  const configured = studioFeatureFlags()
  const groups = studioCapabilityGroups()
  if (!session || session.authMode !== 'login' || !session.accessToken) {
    return { features: configured, configured, degraded: false, missingGroups: {} }
  }
  try {
    const available = await availableGroups(session)
    const ids = new Set(available.map((group) => Number(group.id)).filter((id) => Number.isInteger(id) && id > 0))
    const missingGroups: Partial<Record<StudioCapability, number>> = {}
    const features = { ...configured }
    for (const capability of ['image', 'text', 'video'] as const) {
      const groupId = groups[capability]
      if (groupId && !ids.has(groupId)) {
        features[capability] = false
        missingGroups[capability] = groupId
        await markGroupOrphaned(creativeOwnerIdentity(session).id, groupId)
      }
    }
    return { features, configured, degraded: false, missingGroups }
  } catch {
    return { features: configured, configured, degraded: true, missingGroups: {} }
  }
}

export async function resolveStudioCredential(session: StudioSession, capability: StudioCapability, model?: string) {
  const owner = creativeOwnerIdentity(session)
  if (session.authMode === 'api_key') {
    if (!manualApiKeyLoginEnabled() || !session.apiKey) throw new CreativeCoreError(401, 'AUTH_REQUIRED', 'Sub2API account login is required')
    return { id: null, ownerId: owner.id, groupId: null, remoteKeyId: null, rotationVersion: 0, apiKey: session.apiKey, managed: false } satisfies StudioProviderCredential
  }
  const groupId = studioGroupFor(capability, model)
  if (!groupId) throw new CreativeCoreError(409, 'STUDIO_FEATURE_NOT_CONFIGURED', `Studio ${capability} generation is not configured`)
  if (!creativeCoreConfigured()) {
    if (session.apiKey) return { id: null, ownerId: owner.id, groupId, remoteKeyId: null, rotationVersion: 0, apiKey: session.apiKey, managed: false }
    throw new CreativeCoreError(503, 'STUDIO_CREDENTIAL_UNAVAILABLE', 'Studio credential storage is not configured')
  }
  await persistStudioIdentitySession(session)
  await ensureGroupAvailable(session, owner.id, groupId)
  const existing = await credentialRecord(owner.id, groupId)
  if (existing?.status === 'active' && existing.encrypted_api_key) return resolvedCredential(existing)
  return createManagedCredential(session, owner.id, groupId)
}

export function providerCredentialRejected(error: unknown) {
  if (!(error instanceof Sub2ApiError)) return false
  return error.status === 401
    || error.status === 403
    || /KEY_(?:NOT_FOUND|DISABLED|REVOKED)|invalid api key|api key.*(?:invalid|disabled|revoked)/i.test(`${error.code || ''} ${error.message}`)
}

async function remoteCredentialIsInvalid(session: StudioSession, credential: StudioProviderCredential) {
  if (!credential.remoteKeyId || !session.accessToken) return true
  const response = await sub2apiFetch<unknown>('/api/v1/keys?page=1&page_size=200', { accessToken: session.accessToken })
  const key = unwrapList<Sub2Key>(response).find((candidate) => Number(candidate.id) === credential.remoteKeyId)
  return !key || (key.status !== undefined && key.status !== 'active')
}

export async function rotateStudioCredential(session: StudioSession, credential: StudioProviderCredential) {
  if (!credential.managed || !credential.id || !credential.groupId) return credential
  if (!await remoteCredentialIsInvalid(session, credential)) return credential
  await creativeQuery(
    `UPDATE studio_provider_credentials
        SET status = 'invalid', last_error_code = 'UPSTREAM_CREDENTIAL_REJECTED', updated_at = now()
      WHERE id = $1 AND rotation_version = $2`,
    [credential.id, credential.rotationVersion]
  )
  return createManagedCredential(session, credential.ownerId, credential.groupId, credential)
}

export async function rotateStoredStudioCredential(ownerId: string, credential: StudioProviderCredential) {
  return rotateStudioCredential(await storedIdentitySession(ownerId), credential)
}

export async function withStudioCredential<T>(
  session: StudioSession,
  capability: StudioCapability,
  model: string | undefined,
  run: (credential: StudioProviderCredential) => Promise<T>
) {
  const credential = await resolveStudioCredential(session, capability, model)
  try {
    return await run(credential)
  } catch (error) {
    if (!providerCredentialRejected(error) || !credential.managed) throw error
    const rotated = await rotateStudioCredential(session, credential)
    if (rotated.rotationVersion === credential.rotationVersion) throw error
    return run(rotated)
  }
}

export async function storedStudioCredential(ownerId: string, credentialId: string) {
  const result = await creativeQuery<CredentialRecord>(
    `SELECT * FROM studio_provider_credentials WHERE id = $1 AND owner_id = $2`,
    [credentialId, ownerId]
  )
  const record = result.rows[0]
  if (!record) throw new CreativeCoreError(503, 'STUDIO_CREDENTIAL_UNAVAILABLE', 'Studio provider credential was not found')
  await ensureGroupAvailable(await storedIdentitySession(ownerId), ownerId, Number(record.group_id))
  return resolvedCredential(record)
}
