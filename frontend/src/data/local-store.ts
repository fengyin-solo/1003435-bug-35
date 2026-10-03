import { SEED_ROWS } from './seed'
import type { BatchRecord, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 批次台账的保留键：和记录放在同一个存储对象里，批量提交时记录与台账
// 同一次 setItem 落盘，不会出现「记录改了、台账没记上」的半截状态。
const BATCH_LEDGER_KEY = '__batch_ledger__'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function readLedger(source: Record<string, EntryRow[]>): BatchRecord[] {
  const raw = (source as Record<string, unknown>)[BATCH_LEDGER_KEY]
  return Array.isArray(raw) ? (raw as BatchRecord[]) : []
}

let cache: Record<string, EntryRow[]> | null = null

function persist(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

// 批量事务的回调返回：带 write 才落盘（整批生效），否则一条都不写（整批退回）。
export type BatchTransaction<T> = {
  write?: { rows: EntryRow[]; ledgerEntry?: BatchRecord }
  result: T
}

export function transactRows<T>(
  key: string,
  fn: (current: EntryRow[], ledger: BatchRecord[]) => BatchTransaction<T>,
): T {
  // 绕开内存缓存直读 localStorage：别的标签页刚提交的批次这里能立刻看到，
  // 同一林带被两个批次同时处理时，后提交的一方会在校验阶段被拦下。
  const fresh = readStorage()
  const outcome = fn(clone(fresh[key] ?? []), readLedger(fresh))
  if (outcome.write) {
    const next: Record<string, unknown> = { ...fresh, [key]: outcome.write.rows }
    if (outcome.write.ledgerEntry) {
      next[BATCH_LEDGER_KEY] = [...readLedger(fresh), outcome.write.ledgerEntry]
    }
    persist(next as Record<string, EntryRow[]>)
  } else {
    // 没写入也要把缓存刷成最新，免得本页还拿着别的标签页提交前的旧数据
    cache = fresh
  }
  return outcome.result
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  const current = allRows()
  const ledger = readLedger(current)
  const next: Record<string, unknown> = { ...current, [key]: rows }
  if (ledger.length > 0) {
    // 重置模块时连同它的批次台账一起清，避免重置前的批次号挡住新的提交
    next[BATCH_LEDGER_KEY] = ledger.filter((item) => item.module !== key)
  }
  persist(next as Record<string, EntryRow[]>)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
