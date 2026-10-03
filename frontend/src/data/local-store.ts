import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 全部业务数据（含验收台账等扩展域）都在同一个存储 key 下，
// 这样一次 setItem 就是一次事务：要么全写进去，要么一个字都不动。
type EntriesMap = Record<string, unknown>

function readStorage(): EntriesMap {
  const fallback: EntriesMap = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as EntriesMap
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: EntriesMap | null = null

export function allRows(): Record<string, EntryRow[]> {
  return allState() as Record<string, EntryRow[]>
}

// 只读访问完整存储（含验收域），不会把临时结构写回缓存。
export function readState(): EntriesMap {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function allState(): EntriesMap {
  return readState()
}

function persist(state: EntriesMap): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    // 单次写入即提交：浏览器在本次同步赋值里不会读到中间态。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function listRows(key: string): EntryRow[] {
  return (allRows()[key] ?? []) as EntryRow[]
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allState(), [key]: rows })
}

// 批量事务：在同一份草稿上依次改动，最后一次性落库。
// mutate 抛错时缓存和 localStorage 都保持上一个已提交版本。
export function mutateState(mutate: (draft: EntriesMap) => void): EntriesMap {
  const draft = clone(allState())
  mutate(draft)
  persist(draft)
  return draft
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
