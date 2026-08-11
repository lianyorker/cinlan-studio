'use client'

import { useEffect, useState } from 'react'
import { Sidebar, type Tab } from '@/components/sidebar'
import { TopBar } from '@/components/topbar'
import { GenerationSurface } from '@/components/generation-surface'
import { TextSurface } from '@/components/text-surface'
import { SettingsSurface } from '@/components/settings-surface'
import { HistoryGrid } from '@/components/history-grid'
import { ModelPicker } from '@/components/model-picker'
import { ConnectModal, type ConnectMode } from '@/components/connect-modal'
import { useStudio } from '@/lib/studio'
import { useI18n } from '@/lib/i18n'
import { isLocalModel } from '@/lib/local/model'
import type { Model } from '@/lib/types'

const modelStorageKeys = {
  image: 'cinlan-model-image',
  text: 'cinlan-model-text',
  video: 'cinlan-model-video',
} as const
const generationModeStorageKey = 'cinlan-generation-mode'
const defaultModelSlugs = { image: 'gpt-image-2', text: 'gpt-4.1-mini', video: 'seedance-2.0' } as const
type GenerationTab = keyof typeof modelStorageKeys
const generationTabs: GenerationTab[] = ['image', 'text', 'video']

function isGenerationTab(tab: Tab): tab is keyof typeof modelStorageKeys {
  return tab === 'image' || tab === 'text' || tab === 'video'
}

function preferredModel(tab: keyof typeof modelStorageKeys, models: Model[], savedSlug: string | null, cloudOnly = false) {
  const available = models.filter((candidate) => !candidate.is_coming_soon && (!cloudOnly || !isLocalModel(candidate)))
  return available.find((candidate) => candidate.slug === savedSlug)
    ?? available.find((candidate) => candidate.slug === defaultModelSlugs[tab])
    ?? available.find((candidate) => !isLocalModel(candidate))
    ?? available[0]
}

function SurfaceSkeleton({ tab }: { tab: 'image' | 'text' | 'video' }) {
  const { t } = useI18n()
  const controlSkeletons = tab === 'image'
    ? [
        ['model', 'w-28 sm:w-40', 'skeleton-model-control'],
        ['aspect', 'w-20', undefined],
        ['quality', 'w-20', 'skeleton-quality-control'],
        ['count', 'w-20', undefined],
      ]
    : tab === 'video'
      ? [
          ['model', 'w-28 sm:w-40', 'skeleton-model-control'],
          ['aspect', 'w-20', undefined],
          ['duration', 'w-20', 'skeleton-quality-control'],
        ]
      : [
          ['model', 'w-28 sm:w-40', 'skeleton-model-control'],
          ['reasoning', 'w-24', 'skeleton-quality-control'],
        ]
  const composerSkeleton = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3 sm:px-4 sm:pb-5">
      <div className="composer-shell mx-auto max-w-5xl">
        <div className="h-24 px-4 pt-4"><div className="h-3.5 w-2/3 rounded bg-neutral-100 dark:bg-neutral-900" /><div className="mt-3 h-3.5 w-2/5 rounded bg-neutral-100 dark:bg-neutral-900" /></div>
        <div className="flex items-center gap-2 px-3 pb-3 pt-2">
          {tab !== 'text' && <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-100 dark:bg-neutral-900" />}
          <div className="flex min-w-0 flex-1 justify-end gap-1 overflow-hidden">
            {controlSkeletons.map(([key, width, testId]) => (
              <div key={key} data-testid={testId} className={`h-8 shrink-0 rounded-full bg-neutral-100 dark:bg-neutral-900 ${width}`} />
            ))}
          </div>
          <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800" />
        </div>
      </div>
    </div>
  )

  if (tab === 'text') return (
    <div data-testid="surface-skeleton" role="status" aria-label={t.ws.loadingModels} aria-busy="true" className="relative flex h-full flex-col overflow-hidden animate-pulse">
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-44 pt-8 sm:px-6 sm:pb-48">
        <div className="mx-auto max-w-4xl">
          <div className="h-3 w-28 rounded bg-neutral-100 dark:bg-neutral-900" />
          <div className="mt-3 h-8 w-52 rounded bg-neutral-100 dark:bg-neutral-900" />
          <div className="mt-3 h-3 w-72 max-w-full rounded bg-neutral-100 dark:bg-neutral-900" />
          <div className="mt-8 border-t border-neutral-200 pt-12 dark:border-neutral-800">
            <div className="space-y-3">{[88, 72, 94, 64, 81].map((width) => <div key={width} style={{ width: `${width}%` }} className="h-3 rounded bg-neutral-100 dark:bg-neutral-900" />)}</div>
          </div>
        </div>
      </div>
      {composerSkeleton}
    </div>
  )

  return (
    <div data-testid="surface-skeleton" role="status" aria-label={t.ws.loadingModels} aria-busy="true" className="relative flex h-full flex-col animate-pulse">
      <div className="flex-1 px-6 py-10"><div className="mx-auto max-w-5xl"><div className="h-6 w-24 rounded bg-neutral-100 dark:bg-neutral-900" /><div className="mt-3 h-3 w-36 rounded bg-neutral-100 dark:bg-neutral-900" /><div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="aspect-square rounded-lg bg-neutral-100 dark:bg-neutral-900" />)}</div></div></div>
      {composerSkeleton}
    </div>
  )
}

export default function Studio() {
  const { t } = useI18n()
  const { imageModels, videoModels, textModels, connected, loadingModels, modelsError, modelsReconnectRequired, refreshModels, refreshLocal, creativeCore, loadingCreativeConfig } = useStudio()
  const titles: Record<Tab, string> = { image: t.nav.image, text: t.nav.text, video: t.nav.video, history: t.nav.history, settings: t.nav.settings }
  const [tab, setTab] = useState<Tab>('image')
  const [selectedModels, setSelectedModels] = useState<Record<GenerationTab, Model | null>>({ image: null, text: null, video: null })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectMode, setConnectMode] = useState<ConnectMode>('login')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('cinlan-sidebar-collapsed')
    if (saved === 'true') setCollapsed(true)
  }, [])

  useEffect(() => {
    if (loadingCreativeConfig || !isGenerationTab(tab) || creativeCore.features[tab]) return
    const next = generationTabs.find((candidate) => creativeCore.features[candidate])
    setTab(next ?? 'history')
  }, [creativeCore.features, loadingCreativeConfig, tab])

  function toggleSidebar() {
    setCollapsed((value) => {
      const next = !value
      localStorage.setItem('cinlan-sidebar-collapsed', String(next))
      return next
    })
  }

  const lists: Record<GenerationTab, Model[]> = { image: imageModels, text: textModels, video: videoModels }
  const currentList = isGenerationTab(tab) ? lists[tab] : imageModels
  const currentModel = isGenerationTab(tab) ? selectedModels[tab] : selectedModels.image

  useEffect(() => {
    setSelectedModels((current) => {
      const next = { ...current }
      let changed = false
      for (const target of generationTabs) {
        const list = target === 'image' ? imageModels : target === 'text' ? textModels : videoModels
        const savedSlug = localStorage.getItem(modelStorageKeys[target])
        const cloudOnly = target === 'image'
        if (target === 'image' && localStorage.getItem(generationModeStorageKey) === 'local') {
          localStorage.setItem(generationModeStorageKey, 'cloud')
        }
        if (target === 'image' && savedSlug && isLocalModel(savedSlug)) {
          localStorage.removeItem(modelStorageKeys.image)
        }
        const live = current[target] ? list.find((candidate) => candidate.slug === current[target]?.slug) : undefined
        const resolved = live && !(cloudOnly && isLocalModel(live))
          ? live
          : preferredModel(target, list, savedSlug, cloudOnly) ?? null
        if (resolved !== current[target]) {
          next[target] = resolved
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [imageModels, textModels, videoModels])

  useEffect(() => {
    const imageModel = selectedModels.image
    if (!imageModel || !isLocalModel(imageModel)) return
    void refreshLocal()
    const onFocus = () => void refreshLocal()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [selectedModels.image, refreshLocal])

  function pickModel(nextModel: Model) {
    const target = isGenerationTab(tab) ? tab : 'image'
    setSelectedModels((current) => ({ ...current, [target]: nextModel }))
    localStorage.setItem(modelStorageKeys[target], nextModel.slug)
    if (target === 'image') localStorage.setItem(generationModeStorageKey, 'cloud')
  }

  function openConnect(mode: ConnectMode = 'login') {
    setConnectMode(mode)
    setConnectOpen(true)
  }

  function useCloud() {
    const cloudModel = imageModels.find((candidate) => candidate.slug === 'gpt-image-2' && !candidate.is_coming_soon) ?? imageModels.find((candidate) => !isLocalModel(candidate) && !candidate.is_coming_soon)
    localStorage.setItem(generationModeStorageKey, 'cloud')
    setTab('image')
    if (cloudModel) {
      localStorage.setItem(modelStorageKeys.image, cloudModel.slug)
      setSelectedModels((current) => ({ ...current, image: cloudModel }))
      if (!connected) openConnect('login')
      return
    }
    localStorage.setItem(modelStorageKeys.image, defaultModelSlugs.image)
    setSelectedModels((current) => ({ ...current, image: null }))
    openConnect('login')
  }

  function renderGenerationSurface(target: GenerationTab) {
    const targetModel = selectedModels[target]
    if (loadingModels) return <SurfaceSkeleton tab={target} />
    if (targetModel && targetModel.type !== target) return <SurfaceSkeleton tab={target} />
    if (!targetModel) {
      if (modelsError) {
        return (
          <div className="grid h-full place-items-center px-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-neutral-500">{t.ws.modelCatalogError}</p>
              <button type="button" onClick={() => modelsReconnectRequired ? openConnect('reauth') : void refreshModels()} className="h-9 rounded-md border border-transparent bg-transparent px-3.5 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white">{modelsReconnectRequired ? t.ws.reconnectApiKey : t.ws.reload}</button>
            </div>
          </div>
        )
      }
      const message = loadingModels
        ? t.ws.loadingModels
        : t.ws.noModels.replace('{type}', titles[target])
      return <div className="grid h-full place-items-center text-sm text-neutral-400">{message}</div>
    }
    if (target === 'text') return <TextSurface model={targetModel} onOpenPicker={() => setPickerOpen(true)} onNeedConnect={() => openConnect('login')} />
    return <GenerationSurface model={targetModel} onOpenPicker={() => setPickerOpen(true)} onNeedConnect={openConnect} onUseCloud={useCloud} />
  }

  return <div className="flex h-screen overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <Sidebar tab={tab} onTab={setTab} collapsed={collapsed} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} features={creativeCore.features} />
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar title={titles[tab]} collapsed={collapsed} onToggleSidebar={toggleSidebar} onOpenMobile={() => setMobileOpen(true)} onOpenConnect={() => openConnect('login')} />
      <main className="relative min-h-0 flex-1">
        <div className={`absolute inset-0 ${isGenerationTab(tab) ? '' : 'hidden'}`}>
          {generationTabs.map((target) => (
            <div key={target} className={`h-full ${tab === target ? '' : 'hidden'}`}>
              {renderGenerationSurface(target)}
            </div>
          ))}
        </div>
        {tab === 'history' && <div className="absolute inset-0 overflow-y-auto px-4 sm:px-6"><HistoryGrid modelType="all" refreshToken={0} /></div>}
        {tab === 'settings' && <div className="absolute inset-0"><SettingsSurface onOpenConnect={() => openConnect('login')} /></div>}
      </main>
    </div>
    <ModelPicker open={pickerOpen} models={currentList} current={currentModel?.slug ?? ''} onPick={pickModel} onClose={() => setPickerOpen(false)} />
    <ConnectModal open={connectOpen} initialMode={connectMode} onClose={() => setConnectOpen(false)} />
  </div>
}
