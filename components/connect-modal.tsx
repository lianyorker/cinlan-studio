'use client'

import { useEffect, useRef, useState } from 'react'
import { useStudio } from '@/lib/studio'
import { Logo } from './logo'
import { IconX } from './icons'
import { useI18n } from '@/lib/i18n'

export type ConnectMode = 'login' | 'key' | 'reauth'
type ConnectFormMode = 'login' | 'key'

export function ConnectModal({ open, initialMode = 'login', onClose }: { open: boolean; initialMode?: ConnectMode; onClose: () => void }) {
  const { t } = useI18n()
  const { connect, login, login2fa, disconnect, connected, me, creativeCore } = useStudio()
  const [mode, setMode] = useState<ConnectFormMode>(initialMode === 'key' ? 'key' : 'login')
  const [editingConnection, setEditingConnection] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [key, setKey] = useState('')
  const [code, setCode] = useState('')
  const [tempToken, setTempToken] = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)

  useEffect(() => {
    if (!open) return
    const nextMode: ConnectFormMode = initialMode === 'key' && creativeCore.api_key_login_enabled ? 'key' : 'login'
    setMode(nextMode)
    setEditingConnection(nextMode === 'key' || initialMode === 'reauth')
    setError('')
    setTempToken('')
    setCode('')
  }, [creativeCore.api_key_login_enabled, initialMode, open])

  if (!open) return null

  async function submit() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      if (tempToken) {
        await login2fa(tempToken, code.trim())
      } else if (mode === 'login') {
        const response = await login(email.trim(), password)
        if (response?.requires_2fa) {
          setTempToken(String(response.temp_token || ''))
          setMaskedEmail(String(response.user_email_masked || ''))
          return
        }
      } else {
        await connect(key.trim())
      }
      setPassword('')
      setKey('')
      setCode('')
      setTempToken('')
      setEditingConnection(false)
      onClose()
    } catch (err) {
      const timedOut = err instanceof DOMException && ['AbortError', 'TimeoutError'].includes(err.name)
      setError(timedOut ? t.connect.requestTimeout : err instanceof Error ? err.message : t.connect.connectionFailed)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const showAccount = connected && me && !editingConnection

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button type="button" aria-label={t.connect.close} className="absolute inset-0 bg-neutral-950/35 backdrop-blur-sm" onClick={onClose} />
      <div data-testid="connect-modal" className="relative w-full max-w-md rounded-lg border border-neutral-200 bg-white p-6 shadow-2xl dark:border-neutral-800 dark:bg-neutral-950 sm:p-7">
        <button type="button" onClick={onClose} aria-label={t.connect.close} className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-900 dark:hover:text-white"><IconX className="h-4 w-4" /></button>
        <div className="flex items-center gap-3"><Logo size={38} /><div><h2 className="text-base font-bold">{showAccount ? t.connect.account : t.connect.title}</h2><p className="text-xs text-neutral-400">{t.brand.tagline}</p></div></div>

        {showAccount ? (
          <div className="mt-6">
            <div className="border-y border-neutral-100 py-4 dark:border-neutral-900"><div className="text-sm font-medium">{me.email || me.name || `${t.connect.apiKey} ${t.connect.connected}`}</div><div className="mt-1 text-xs text-neutral-400">{t.settings.balance} {me.credits ?? '-'}</div></div>
            <p className="mt-4 text-xs leading-5 text-neutral-400">{t.connect.bffDesc}</p>
            <div className="mt-5 grid gap-2">
              <button type="button" onClick={() => { setMode(creativeCore.api_key_login_enabled ? 'key' : 'login'); setEditingConnection(true); setError('') }} className="primary-btn h-10 w-full">{creativeCore.api_key_login_enabled ? t.connect.reconnectKey : t.connect.loginTab}</button>
              <button type="button" onClick={() => { disconnect(); onClose() }} className="h-10 w-full rounded-md border border-neutral-200 text-sm font-medium transition hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">{t.connect.disconnect}</button>
            </div>
          </div>
        ) : (
          <>
            {!tempToken && (
              <div className="mt-6 flex rounded-md border border-neutral-200 bg-neutral-50 p-1 dark:border-neutral-800 dark:bg-neutral-900">
                <button type="button" onClick={() => { setMode('login'); setError('') }} className={`h-8 flex-1 rounded text-xs font-semibold transition ${mode === 'login' ? 'bg-white shadow-sm dark:bg-neutral-800' : 'text-neutral-400'}`}>{t.connect.loginTab}</button>
                {creativeCore.api_key_login_enabled && <button type="button" onClick={() => { setMode('key'); setError('') }} className={`h-8 flex-1 rounded text-xs font-semibold transition ${mode === 'key' ? 'bg-white shadow-sm dark:bg-neutral-800' : 'text-neutral-400'}`}>API Key</button>}
              </div>
            )}
            <div className="mt-5 space-y-3">
              {tempToken ? (
                <>
                  <div><label className="text-xs font-medium text-neutral-500">{t.connect.verificationCode}</label><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} autoFocus inputMode="numeric" placeholder={t.connect.verificationPlaceholder} className="mt-1.5 w-full rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900" /></div>
                  {maskedEmail && <p className="text-xs text-neutral-400">{t.connect.codeSentTo.replace('{email}', maskedEmail)}</p>}
                </>
              ) : mode === 'login' ? (
                <>
                  <div><label className="text-xs font-medium text-neutral-500">{t.connect.email}</label><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" className="mt-1.5 w-full rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900" /></div>
                  <div><label className="text-xs font-medium text-neutral-500">{t.connect.password}</label><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} autoComplete="current-password" placeholder={t.connect.passwordPlaceholder} className="mt-1.5 w-full rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900" /></div>
                </>
              ) : (
                <div><label className="text-xs font-medium text-neutral-500">Sub2API Key</label><input value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} autoFocus placeholder="sk-..." className="mt-1.5 w-full rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 font-mono text-sm outline-none focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900" /></div>
              )}
              {error && <p role="alert" className="text-xs leading-5 text-red-600">{error}</p>}
              <button type="button" onClick={() => void submit()} disabled={busy || (tempToken ? !code.trim() : mode === 'login' ? !email.trim() || !password : !key.trim())} className="primary-btn h-10 w-full disabled:opacity-50">{busy ? t.connect.processing : tempToken ? t.connect.verifyAndLogin : mode === 'login' ? t.connect.login : t.connect.connectKey}</button>
              {tempToken && <button type="button" onClick={() => { setTempToken(''); setCode('') }} className="w-full py-1 text-xs text-neutral-400">{t.connect.backToLogin}</button>}
              {connected && <button type="button" onClick={() => setEditingConnection(false)} className="w-full py-1 text-xs text-neutral-400">{t.connect.backToAccount}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
