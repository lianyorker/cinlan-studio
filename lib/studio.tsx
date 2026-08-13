'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, bootstrapEmbeddedSession } from './api'
import { FALLBACK_IMAGE, FALLBACK_VIDEO, TRENDING_LIVE_SLUGS, TRENDING_STUBS } from './catalog'
import type { CreativeCoreConfig } from './creative-types'
import { LOCAL_MODEL } from './local/model'
import type { LocalState } from './local/types'
import type { Me, Model } from './types'

const INITIAL_LOCAL_STATE: LocalState = {
  status: 'offline',
  hint: 'unknown',
  system: null,
  unetFile: null,
}

interface StudioState {
  me: Me | null
  connected: boolean
  imageModels: Model[]
  videoModels: Model[]
  textModels: Model[]
  trending: Model[]
  loadingModels: boolean
  modelsError: boolean
  modelsErrorMessage: string
  modelsReconnectRequired: boolean
  creativeCore: CreativeCoreConfig
  loadingCreativeConfig: boolean
  localState: LocalState
  connect: (key: string) => Promise<void>
  login: (email: string, password: string) => Promise<any>
  login2fa: (tempToken: string, code: string) => Promise<any>
  disconnect: () => void
  refreshMe: () => Promise<void>
  refreshModels: () => Promise<void>
  refreshCreativeConfig: () => Promise<void>
  refreshLocal: () => Promise<void>
}

const EMPTY_FEATURE_STATUS = {
  image: { configured: false, available: false, degraded: false, group_id: null },
  text: { configured: false, available: false, degraded: false, group_id: null },
  video: { configured: false, available: false, degraded: false, group_id: null },
}

const EMPTY_CORE_CONFIG: CreativeCoreConfig = {
  enabled: false,
  database: 'postgresql',
  asset_storage: 'filesystem',
  planner_enabled: false,
  features: { image: false, text: false, video: false },
  feature_status: EMPTY_FEATURE_STATUS,
  api_key_login_enabled: false,
}

const StudioCtx = createContext<StudioState>({
  me: null,
  connected: false,
  imageModels: FALLBACK_IMAGE,
  videoModels: FALLBACK_VIDEO,
  textModels: [{ slug: 'gpt-4.1-mini', name: 'GPT-4.1 mini', type: 'text', creator: 'OpenAI' }],
  trending: TRENDING_STUBS,
  loadingModels: true,
  modelsError: false,
  modelsErrorMessage: '',
  modelsReconnectRequired: false,
  creativeCore: EMPTY_CORE_CONFIG,
  loadingCreativeConfig: true,
  localState: INITIAL_LOCAL_STATE,
  connect: async () => {},
  login: async () => ({}),
  login2fa: async () => ({}),
  disconnect: () => {},
  refreshMe: async () => {},
  refreshModels: async () => {},
  refreshCreativeConfig: async () => {},
  refreshLocal: async () => {},
})

function meFromAuthResponse(data: any): Me | null {
  const user = data?.user
  if (!user || user.id === undefined || user.id === null) return null
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? user.username ?? null,
    credits: data.balance ?? user.balance ?? null,
    currency: 'USD',
  }
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [imageModels, setImageModels] = useState<Model[]>([])
  const [videoModels, setVideoModels] = useState<Model[]>([])
  const [textModels, setTextModels] = useState<Model[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [modelsError, setModelsError] = useState(false)
  const [modelsErrorMessage, setModelsErrorMessage] = useState('')
  const [modelsReconnectRequired, setModelsReconnectRequired] = useState(false)
  const [creativeCore, setCreativeCore] = useState<CreativeCoreConfig>(EMPTY_CORE_CONFIG)
  const [loadingCreativeConfig, setLoadingCreativeConfig] = useState(true)
  const [catalogAuthoritative, setCatalogAuthoritative] = useState(false)
  const [localState, setLocalState] = useState<LocalState>(INITIAL_LOCAL_STATE)
  const modelRequestId = useRef(0)

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me())
    } catch {
      setMe(null)
    }
  }, [])

  const refreshLocal = useCallback(async () => {
    setLocalState(INITIAL_LOCAL_STATE)
  }, [])

  const refreshCreativeConfig = useCallback(async () => {
    try {
      setCreativeCore(await api.creativeConfig())
    } finally {
      setLoadingCreativeConfig(false)
    }
  }, [])

  const refreshModels = useCallback(async () => {
    const requestId = ++modelRequestId.current
    setLoadingModels(true)
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { models, authoritative = false, degraded = false, reconnect_required = false, error } = await api.models()
          if (degraded && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 600))
            continue
          }
          if (requestId !== modelRequestId.current) return
          setImageModels(models.filter((m) => m.type === 'image'))
          setVideoModels(models.filter((m) => m.type === 'video'))
          setTextModels(models.filter((m) => m.type === 'text'))
          setCatalogAuthoritative(authoritative)
          setModelsError(degraded)
          setModelsErrorMessage(degraded ? (error?.message || '模型目录加载失败，请稍后重试') : '')
          setModelsReconnectRequired(degraded && reconnect_required)
          return
        } catch {
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 600))
            continue
          }
        }
      }
      if (requestId === modelRequestId.current) {
        setModelsError(true)
        setModelsErrorMessage('模型目录加载失败，请稍后重试')
        setModelsReconnectRequired(false)
      }
    } catch {
      if (requestId === modelRequestId.current) {
        setModelsError(true)
        setModelsErrorMessage('模型目录加载失败，请稍后重试')
        setModelsReconnectRequired(false)
      }
    } finally {
      if (requestId === modelRequestId.current) setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    // No mounted guard: React StrictMode's dev double-invoke would otherwise
    // drop the resolved catalog and leave us on the fallback list.
    let active = true
    void (async () => {
      await bootstrapEmbeddedSession().catch(() => false)
      if (!active) return
      await Promise.all([
        refreshModels(),
        refreshMe(),
        refreshCreativeConfig().catch(() => {}),
      ])
    })()
    return () => { active = false }
  }, [refreshCreativeConfig, refreshMe, refreshModels])

  const connect = useCallback(async (key: string) => {
    const response = await fetch('/api/v1/auth/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.message || 'Key 无效')
    try {
      const nextMe = await api.me()
      setMe(nextMe)
      void Promise.allSettled([refreshModels(), refreshCreativeConfig()])
    } catch (error) {
      setMe(null)
      throw error
    }
  }, [refreshCreativeConfig, refreshModels])

  const login = useCallback(async (email: string, password: string) => {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.message || '登录失败')
    if (data?.requires_2fa) return data
    const nextMe = meFromAuthResponse(data) ?? await api.me()
    setMe(nextMe)
    void Promise.allSettled([refreshModels(), refreshCreativeConfig()])
    return data
  }, [refreshCreativeConfig, refreshModels])

  const login2fa = useCallback(async (tempToken: string, code: string) => {
    const response = await fetch('/api/v1/auth/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temp_token: tempToken, code }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.message || '二次验证失败')
    const nextMe = meFromAuthResponse(data) ?? await api.me()
    setMe(nextMe)
    void Promise.allSettled([refreshModels(), refreshCreativeConfig()])
    return data
  }, [refreshCreativeConfig, refreshModels])

  const disconnect = useCallback(() => {
    void fetch('/api/v1/auth/logout', { method: 'POST' }).finally(() => Promise.all([refreshModels(), refreshCreativeConfig()]))
    setMe(null)
  }, [refreshCreativeConfig, refreshModels])

  const allowPreviewFallback = !catalogAuthoritative && (!me || loadingModels)
  const cloudImage = imageModels.length || !allowPreviewFallback ? imageModels : FALLBACK_IMAGE
  const resolvedImage = cloudImage.filter((model) => model.slug !== LOCAL_MODEL.slug)
  const resolvedVideo = videoModels.length || !allowPreviewFallback ? videoModels : FALLBACK_VIDEO
  const resolvedText = textModels.length || !allowPreviewFallback ? textModels : [{ slug: 'gpt-4.1-mini', name: 'GPT-4.1 mini', type: 'text', creator: 'OpenAI' }]
  const trending = [
    ...(TRENDING_LIVE_SLUGS.map((slug) =>
      [...resolvedImage, ...resolvedVideo].find((m) => m.slug === slug)
    ).filter(Boolean) as Model[]),
    ...TRENDING_STUBS,
  ]

  return (
    <StudioCtx.Provider
      value={{
        me,
        connected: !!me,
        imageModels: resolvedImage,
        videoModels: resolvedVideo,
        textModels: resolvedText,
        trending,
        loadingModels,
        modelsError,
        modelsErrorMessage,
        modelsReconnectRequired,
        creativeCore,
        loadingCreativeConfig,
        localState,
        connect,
        login,
        login2fa,
        disconnect,
        refreshMe,
        refreshModels,
        refreshCreativeConfig,
        refreshLocal,
      }}
    >
      {children}
    </StudioCtx.Provider>
  )
}

export const useStudio = () => useContext(StudioCtx)
