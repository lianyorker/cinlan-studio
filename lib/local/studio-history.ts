export type StudioHistoryType = 'image' | 'video' | 'text'
export type StudioHistoryStatus = 'COMPLETED' | 'FAILED'

export interface StudioHistoryRecord {
  id: string
  type: StudioHistoryType
  source: 'cloud'
  model: string
  prompt: string
  resultUrl?: string
  textResult?: string
  status: StudioHistoryStatus
  error?: string
  createdAt: number
}

const DB_NAME = 'cinlan-studio-history'
const STORE = 'items'
const MAX_ITEMS = 200

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveStudioHistory(item: StudioHistoryRecord) {
  try {
    const db = await openDb()
    await request(db, 'readwrite', (s) => s.put(item))
    const all = await request<StudioHistoryRecord[]>(db, 'readonly', (s) => s.getAll() as IDBRequest<StudioHistoryRecord[]>)
    if (all.length > MAX_ITEMS) {
      const old = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - MAX_ITEMS)
      for (const record of old) await request(db, 'readwrite', (s) => s.delete(record.id))
    }
    db.close()
  } catch {
    // History is an enhancement; generation should not fail when IndexedDB is unavailable.
  }
}

export async function listStudioHistory(type?: StudioHistoryType) {
  try {
    const db = await openDb()
    const all = await request<StudioHistoryRecord[]>(db, 'readonly', (s) => s.getAll() as IDBRequest<StudioHistoryRecord[]>)
    db.close()
    return all.filter((item) => !type || item.type === type).sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function deleteStudioHistory(id: string) {
  try {
    const db = await openDb()
    await request(db, 'readwrite', (s) => s.delete(id))
    db.close()
  } catch {}
}

export async function clearStudioHistory(ids?: string[]) {
  try {
    const db = await openDb()
    if (ids?.length) {
      for (const id of ids) await request(db, 'readwrite', (s) => s.delete(id))
    } else {
      await request(db, 'readwrite', (s) => s.clear())
    }
    db.close()
  } catch {}
}
