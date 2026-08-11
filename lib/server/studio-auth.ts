import { getStudioSession, setStudioSession, type StudioSession } from './session'
import { newRequestId, sub2apiFetch, type Sub2ApiError } from './sub2api'
import { creativeCoreConfigured } from './creative/config'
import { persistStudioIdentitySession } from './creative/provider-credentials'
import { studioCapabilityGroups } from './studio-config'

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
    const obj = value as { items?: unknown; data?: unknown }
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
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

export async function createOrResolveStudioKey(accessToken: string): Promise<{ key: string; group?: Sub2Group }> {
  const [keysResponse, groupsResponse] = await Promise.all([
    sub2apiFetch<unknown>('/api/v1/keys?page=1&page_size=100', { accessToken }),
    sub2apiFetch<unknown>('/api/v1/groups/available', { accessToken }),
  ])
  const keys = unwrapList<Sub2Key>(keysResponse)
  const groups = unwrapList<Sub2Group>(groupsResponse)
  const group = chooseGroup(groups)
  if (!group?.id) throw new Error('Sub2API \u6ca1\u6709\u53ef\u7528\u4e8e Cinlan Studio \u7684\u5206\u7ec4\uff0c\u8bf7\u5148\u914d\u7f6e\u53ef\u7528\u5206\u7ec4')

  const existing = activeKey(keys, group)
  if (existing?.key) return { key: existing.key, group }

  const created = await sub2apiFetch<Sub2Key>('/api/v1/keys', {
    accessToken,
    method: 'POST',
    headers: { 'Idempotency-Key': newRequestId('studio-key') },
    body: JSON.stringify({ name: 'Cinlan Studio', group_id: group.id }),
  })
  if (!created.key) throw new Error('Sub2API 未返回新建 API Key，请检查 Key 创建权限')
  return { key: created.key, group }
}

export async function persistLoginSession(input: {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  user?: Sub2User | null
}) {
  const user = input.user ?? await sub2apiFetch<Sub2User>('/api/v1/auth/me', { accessToken: input.accessToken })
  if (user?.id === undefined || user.id === null) {
    throw new Error('Sub2API did not return a user identity')
  }
  const apiKey = creativeCoreConfigured()
    ? undefined
    : (await createOrResolveStudioKey(input.accessToken)).key
  const session: StudioSession = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    accessExpiresAt: input.expiresIn ? Date.now() + input.expiresIn * 1000 : undefined,
    apiKey,
    authMode: 'login',
    user: { id: user?.id, email: user?.email, name: user?.username, balance: user?.balance ?? null },
  }
  await persistStudioIdentitySession(session)
  await setStudioSession(session)
  return session
}

export async function persistEmbeddedSession(accessToken: string, expectedUserId?: string) {
  const user = await sub2apiFetch<Sub2User>('/api/v1/auth/me', { accessToken })
  if (user?.id === undefined || user.id === null) {
    throw new Error('Sub2API 未返回嵌入用户标识')
  }
  if (expectedUserId && String(user.id) !== expectedUserId) {
    throw new Error('Sub2API 嵌入用户与令牌不匹配')
  }
  return persistLoginSession({ accessToken, user })
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
  await persistStudioIdentitySession(refreshed)
  await setStudioSession(refreshed)
  return refreshed
}

export async function requireStudioSession() {
  const session = await getStudioSession()
  if (!session) throw new Error('请先登录 Cinlan Studio')
  return refreshStudioSession(session)
}

export function isSub2ApiError(error: unknown): error is Sub2ApiError {
  return !!error && typeof error === 'object' && 'status' in error && 'message' in error
}
