function legacyCopy(text: string) {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  el.style.top = '0'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.focus()
  el.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    el.remove()
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
    active?.focus({ preventScroll: true })
  }
  return copied
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Embedded pages may deny Clipboard API access; retain a user-gesture fallback.
    }
  }
  try {
    return legacyCopy(text)
  } catch {
    return false
  }
}
