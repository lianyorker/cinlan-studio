/** Legacy key storage kept only for migration from the pre-login client. */
const STORAGE_KEY = 'cinlan_studio_api_key'

export function getKey(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY)
}

export function setKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key.trim())
}

export function clearKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function hasKey(): boolean {
  return !!getKey()
}
