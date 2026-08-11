/**
 * 로컬 생성 히스토리 저장소 (IndexedDB)
 *
 * 로컬 생성물은 서버에 저장되지 않으므로 브라우저 IndexedDB에 blob째 보관해
 * 새로고침 후에도 히스토리 그리드에 남게 한다. 최근 MAX_ITEMS개만 유지.
 */

export interface LocalHistoryItem {
  id: string
  prompt: string
  width: number
  height: number
  seed: number
  createdAt: number
}

export interface LocalHistoryEntry extends LocalHistoryItem {
  /** 렌더 시점에 blob으로부터 생성 — revoke는 호출자 책임 아님(페이지 수명 공유) */
  objectUrl: string
}

const DB_NAME = 'cinlan-local-history'
const STORE = 'generations'
const MAX_ITEMS = 100

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveLocalGeneration(item: LocalHistoryItem, blob: Blob): Promise<void> {
  try {
    const db = await openDb()
    await tx(db, 'readwrite', (s) => s.put({ ...item, blob }))
    // 오래된 항목 정리
    const all = await tx<{ id: string; createdAt: number }[]>(db, 'readonly', (s) => s.getAll() as IDBRequest<{ id: string; createdAt: number }[]>)
    if (all.length > MAX_ITEMS) {
      const excess = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - MAX_ITEMS)
      for (const e of excess) await tx(db, 'readwrite', (s) => s.delete(e.id))
    }
    db.close()
  } catch {
    // 저장 실패는 치명적이지 않음 — 이번 세션의 objectUrl은 계속 동작
  }
}

export async function listLocalHistory(): Promise<LocalHistoryEntry[]> {
  try {
    const db = await openDb()
    const all = await tx<Array<LocalHistoryItem & { blob: Blob }>>(db, 'readonly', (s) => s.getAll() as IDBRequest<Array<LocalHistoryItem & { blob: Blob }>>)
    db.close()
    return all
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ blob, ...meta }) => ({ ...meta, objectUrl: URL.createObjectURL(blob) }))
  } catch {
    return []
  }
}

export async function deleteLocalGeneration(id: string): Promise<void> {
  try {
    const db = await openDb()
    await tx(db, 'readwrite', (s) => s.delete(id))
    db.close()
  } catch {
    // 무시
  }
}
