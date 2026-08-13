import { getStudioSession, setStudioSession, type StudioSession } from './session'
import { creativeCoreConfigured } from './creative/config'
import { CreativeCoreError } from './creative/errors'
import { persistStudioIdentitySession } from './creative/provider-credentials'
import { newRequestId, sub2apiFetch, type Sub2ApiError } from './sub2api'
import { studioCapabilityGroups } from './studio-config'

type LoginSessionCommitDependencies = {
  setSession: typeof setStudioSession
  persistIdentity: typeof persistStudioIdentitySession
}

const loginSessionCommitDependencies: LoginSessionCommitDependencies = {
  setSession: setStudioSession,
  persistIdentity: persistStudioIdentitySession,
}

export async function commitStudioLoginSession(
  session: StudioSession,
  dependencies: LoginSessionCommitDependencies = loginSessionCommitDependencies
) {
  await dependencies.setSession(session)
  void dependencies.persistIdentity(session).catch((error: unknown) => {
    console.error('[auth] Studio identity persistence deferred', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : null,
    })
  })
}

type Sub2User = {
  id?: number
  email?: string | null
  username?: string | null
  balance?: number
}

type Sub2Key = {
  id?: number
  key?: string
  name?: string
  status?: string
  group_id?: number | null
  group?: { id?: number; platform?: string; allow_image_generation?: boolean }
}

type Sub2Group = {
  id?: number
  name?: string
  platform?: string
  allow_image_generation?: boolean
  allow_batch_image_generation?: boolean
}

function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const obj = value as { items?: unknown; data?: unknown; results?: unknown; list?: unknown }
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
    if (Array.isArray(obj.results)) return obj.results as T[]
    if (Array.isArray(obj.list)) return obj.list as T[]
  }
  return []
}

function chooseGroup(groups: Sub2Group[]) {
  const configured = studioCapabilityGroups().image
  if (configured) return groups.find((group) => group.id === configured)

  return groups.find((group) => group.platform?.toLowerCase() === 'composite')
    ?? groups.find((group) => group.allow_image_generation || group.allow_batch_image_generation)
    ?? groups.find((group) => Number.isInteger(group.id) && Number(group.id) > 0)
}

function activeKey(keys: Sub2Key[], group: Sub2Group) {
  const activeKeys = keys.filter((key) => key.status === 'active' && !!key.key)
  const belongsToGroup = (key: Sub2Key) => key.group_id === group.id || key.group?.id === group.id
  const isStudioKey = (key: Sub2Key) => key.name === 'Cinlan Studio'

  return activeKeys.find((key) => isStudioKey(key) && belongsToGroup(key))
}

export async function createOrResolveStudioKey(accessToken: string, signal?: AbortSignal): Promise<{ key: string; group?: Sub2Group }> {
  const [keysResponse, groupsResponse] = await Promise.all([
    sub2apiFetch<unknown>('/api/v1/keys?page=1&page_size=100', { accessToken, signal }),
    sub2apiFetch<unknown>('/api/v1/groups/available', { accessToken, signal }),
  ])
  const keys = unwrapList<Sub2Key>(keysResponse)
  const groups = unwrapList<Sub2Group>(groupsResponse)
  const group = chooseGroup(groups)
  if (!group?.id) {
    throw new CreativeCoreError(409, 'STUDIO_GROUP_NOT_FOUND', 'Sub2API 没有可用于 Cinlan Studio 的分组，请先配置可用分组')
  }

  const existing = activeKey(keys, group)
  if (existing?.key) return { key: existing.key, group }

  const created = await sub2apiFetch<Sub2Key>('/api/v1/keys', {
    accessToken,
    method: 'POST',
    headers: { 'Idempotency-Key': newRequestId('studio-key') },
    body: JSON.stringify({ name: 'Cinlan Studio', group_id: group.id }),
    signal,
  })
  if (!created.key) {
    throw new CreativeCoreError(503, 'STUDIO_CREDENTIAL_UNAVAILABLE', 'Sub2API 未返回新建 API Key，请检查 Key 创建权限')
  }
  return { key: created.key, group }
}

export async function persistLoginSession(input: {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  user?: Sub2User | null
  signal?: AbortSignal
}) {
  const user = input.user ?? await sub2apiFetch<Sub2User>('/api/v1/auth/me', { accessToken: input.accessToken, signal: input.signal })
  if (user?.id === undefined || user.id === null) {
    throw new CreativeCoreError(502, 'SUB2API_USER_IDENTITY_MISSING', 'Sub2API did not return a user identity')
  }
  const apiKey = creativeCoreConfigured()
    ? undefined
    : (await createOrResolveStudioKey(input.accessToken, input.signal)).key
  const session: StudioSession = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    accessExpiresAt: input.expiresIn ? Date.now() + input.expiresIn * 1000 : undefined,
    apiKey,
    authMode: 'login',
    user: { id: user.id, email: user.email, name: user.username, balance: user.balance ?? null },
  }
  await commitStudioLoginSession(session)
  return session
}

export async function persistEmbeddedSession(accessToken: string, expectedUserId?: string, signal?: AbortSignal) {
  const user = await sub2apiFetch<Sub2User>('/api/v1/auth/me', { accessToken, signal })
  if (user?.id === undefined || user.id === null) {
    throw new CreativeCoreError(502, 'SUB2API_USER_IDENTITY_MISSING', 'Sub2API 未返回嵌入用户标识')
  }
  if (expectedUserId && String(user.id) !== expectedUserId) {
    throw new CreativeCoreError(403, 'EMBED_USER_MISMATCH', 'Sub2API 嵌入用户与令牌不匹配')
  }
  return persistLoginSession({ accessToken, user, signal })
}

export async function refreshStudioSession(session: StudioSession) {
  if (!session.refreshToken || !session.accessExpiresAt || session.accessExpiresAt > Date.now() + 30_000) {
    return session
  }
  const response = await sub2apiFetch<{ access_token: string; refresh_token?: string; expires_in?: number }>('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  })
  const refreshed: StudioSession = {
    ...session,
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? session.refreshToken,
    accessExpiresAt: response.expires_in ? Date.now() + response.expires_in * 1000 : undefined,
  }
  await commitStudioLoginSession(refreshed)
  return refreshed
}

export async function requireStudioSession() {
  const session = await getStudioSession()
  if (!session) throw new CreativeCoreError(401, 'AUTH_REQUIRED', '请先登录 Cinlan Studio')
  return refreshStudioSession(session)
}

export function isSub2ApiError(error: unknown): error is Sub2ApiError {
  return !!error && typeof error === 'object' && 'status' in error && 'message' in error
}
