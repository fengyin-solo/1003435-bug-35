import { MODULE_BY_KEY } from './modules'
import type { EntryRow } from './types'

// 防火林带验收域：验收台账、林带锁、补植待办都挂在本地存储同一个 key 下，
// 与林带记录在同一个事务里一次落库，从根上避免「写一半」。
export const ACCEPTANCE_STATE_KEY = '__acceptance__'
const MODULE_KEY = 'firebelt'

// 只有「有缺株 / 需补植」的林带才进验收队列；完好、已退化不参与验收。
export const ACCEPTABLE_STATUSES = ['有缺株', '需补植'] as const
const PASSED_TARGET = '完好'
const FAILED_TARGET = '需补植'

function isPendingAfter(status: string): boolean {
  const meta = MODULE_BY_KEY.get(MODULE_KEY)
  const statuses = meta ? meta.statuses : ['完好', '有缺株', '需补植', '已退化']
  return status !== statuses[statuses.length - 1]
}

export type AcceptanceItem = {
  beltId: number
  passed: boolean
  fromStatus: string
  toStatus: string
  beltCode: string
  beltName: string
  forest: string
}

export type AcceptanceBatch = {
  id: string
  status: 'processing' | 'committed' | 'rolled_back'
  createdAt: number
  committedAt?: number
  rolledBackAt?: number
  rollbackReason?: string
  items: AcceptanceItem[]
}

export type BeltLock = { batchId: string; at: number }

export type ReplenishTodo = {
  beltId: number
  beltCode: string
  beltName: string
  forest: string
  sourceBatchId: string
  createdAt: number
  closed: boolean
  closedBatchId?: string
  closedAt?: number
}

export type AcceptanceState = {
  version: 1
  locks: Record<string, BeltLock>
  batches: Record<string, AcceptanceBatch>
  // 补植待办以林带 id 为键：同一林带永远只有一条，重复提交不会残留两份。
  todos: Record<string, ReplenishTodo>
}

export type AcceptanceInput = {
  batchId: string
  items: Array<{ beltId: number; passed: boolean }>
}

export function emptyAcceptanceState(): AcceptanceState {
  return { version: 1, locks: {}, batches: {}, todos: {} }
}

// 老版本存储里可能没有验收域，也可能写坏过：统一兜底成合法结构。
export function normalizeAcceptanceState(raw: unknown): AcceptanceState {
  if (!raw || typeof raw !== 'object') {
    return emptyAcceptanceState()
  }
  const candidate = raw as Partial<AcceptanceState>
  return {
    version: 1,
    locks: candidate.locks && typeof candidate.locks === 'object' ? candidate.locks : {},
    batches: candidate.batches && typeof candidate.batches === 'object' ? candidate.batches : {},
    todos: candidate.todos && typeof candidate.todos === 'object' ? candidate.todos : {},
  }
}

export function ensureAcceptanceState(draft: Record<string, unknown>): AcceptanceState {
  const state = normalizeAcceptanceState(draft[ACCEPTANCE_STATE_KEY])
  draft[ACCEPTANCE_STATE_KEY] = state
  return state
}

export type HealNotice = {
  batchId: string
  itemCount: number
  beltsRestored: number
}

// 修复历史批次：旧实现逐条落库，半路失败会留下 processing 批次、部分已改状态的林带、
// 没释放的锁和半条补植待办。任何一次读取或新提交前先在同一事务里把这些批次整批退回。
// 只有超过租约仍停在 processing 的批次才算中断——正在处理窗口里的合法批次绝不能动，
// 否则并发提交时后到的事务会把先到批次的在途锁误回收。
export const PROCESSING_TTL_MS = 30_000

export function healInterruptedBatches(
  state: AcceptanceState,
  belts: EntryRow[],
  now: number,
  ttlMs: number = PROCESSING_TTL_MS,
): HealNotice[] {
  const notices: HealNotice[] = []
  for (const batch of Object.values(state.batches)) {
    if (batch.status !== 'processing') {
      continue
    }
    if (now - batch.createdAt <= ttlMs) {
      continue
    }
    let beltsRestored = 0
    for (const item of batch.items) {
      const key = String(item.beltId)
      // 之后已有成功验收覆盖这条林带的，结果以新批次为准，旧批次不再回滚它。
      const coveredByLaterBatch = Object.values(state.batches).some(
        (other) =>
          other.id !== batch.id &&
          other.status === 'committed' &&
          (other.committedAt ?? other.createdAt) >= batch.createdAt &&
          other.items.some((candidate) => candidate.beltId === item.beltId),
      )
      const row = belts.find((belt) => Number(belt.id) === item.beltId)
      if (!coveredByLaterBatch && row && String(row.status) === item.toStatus) {
        // 当前状态正是旧批次半写入的目标态：恢复验收前状态。
        row.status = item.fromStatus
        row.pending = isPendingAfter(item.fromStatus)
        beltsRestored += 1
      }
      const dirtyTodo = state.todos[key]
      if (!coveredByLaterBatch && dirtyTodo && !dirtyTodo.closed && dirtyTodo.sourceBatchId === batch.id) {
        delete state.todos[key]
      }
      if (state.locks[key]?.batchId === batch.id) {
        delete state.locks[key]
      }
    }
    batch.status = 'rolled_back'
    batch.rolledBackAt = now
    batch.rollbackReason = '检测到中断在半路的历史批次，已整批自动回滚，可重新提交验收'
    notices.push({ batchId: batch.id, itemCount: batch.items.length, beltsRestored })
  }
  return notices
}

export type ClaimOutcome =
  | { outcome: 'claimed'; batch: AcceptanceBatch }
  | { outcome: 'duplicate_committed'; batch: AcceptanceBatch }
  | { outcome: 'duplicate_in_flight'; batch: AcceptanceBatch }
  | { outcome: 'duplicate_rolled_back'; batch: AcceptanceBatch }
  | { outcome: 'rejected'; batch: null; message: string }

function shortBatchId(batchId: string): string {
  return batchId.length > 8 ? batchId.slice(0, 8) : batchId
}

// 阶段一：在同一事务内登记 processing 批次并抢占林带锁。
// 只要有一条不满足，整个批次不入账、不加锁。
export function claimBatch(
  state: AcceptanceState,
  belts: EntryRow[],
  input: AcceptanceInput,
  now: number,
): ClaimOutcome {
  const existing = state.batches[input.batchId]
  if (existing) {
    if (existing.status === 'committed') {
      return { outcome: 'duplicate_committed', batch: existing }
    }
    if (existing.status === 'processing') {
      return { outcome: 'duplicate_in_flight', batch: existing }
    }
    return { outcome: 'duplicate_rolled_back', batch: existing }
  }

  const seen = new Set<number>()
  for (const candidate of input.items) {
    if (seen.has(candidate.beltId)) {
      return { outcome: 'rejected', batch: null, message: '同一林带在一个验收批次里只能出现一次，整批未提交' }
    }
    seen.add(candidate.beltId)
  }

  const items: AcceptanceItem[] = []
  for (const candidate of input.items) {
    const key = String(candidate.beltId)
    const row = belts.find((belt) => Number(belt.id) === candidate.beltId)
    if (!row) {
      return { outcome: 'rejected', batch: null, message: `没有找到编号为 ${candidate.beltId} 的防火林带，整批未提交` }
    }
    const lock = state.locks[key]
    if (lock) {
      return {
        outcome: 'rejected',
        batch: null,
        message: `林带「${row['林带编号']}」正在被批次 ${shortBatchId(lock.batchId)} 验收，本批整批退回，请稍后重试`,
      }
    }
    const status = String(row.status)
    if (!(ACCEPTABLE_STATUSES as readonly string[]).includes(status)) {
      return {
        outcome: 'rejected',
        batch: null,
        message: `林带「${row['林带编号']}」当前状态为「${status}」，不在验收队列，整批未提交`,
      }
    }
    items.push({
      beltId: candidate.beltId,
      passed: candidate.passed,
      fromStatus: status,
      toStatus: candidate.passed ? PASSED_TARGET : FAILED_TARGET,
      beltCode: String(row['林带编号'] ?? ''),
      beltName: String(row['林带名称'] ?? ''),
      forest: String(row['所属林区'] ?? ''),
    })
  }

  const batch: AcceptanceBatch = {
    id: input.batchId,
    status: 'processing',
    createdAt: now,
    items,
  }
  state.batches[input.batchId] = batch
  for (const item of items) {
    state.locks[String(item.beltId)] = { batchId: input.batchId, at: now }
  }
  return { outcome: 'claimed', batch }
}

export type FinishOutcome =
  | { outcome: 'committed'; batch: AcceptanceBatch; accepted: number; needReplant: number }
  | { outcome: 'rolled_back'; batch: AcceptanceBatch; message: string }

// 阶段二：处理结束后在同一事务里做版本校验，再一次性提交。
// 林带状态、验收台账、补植待办、锁同生共死：任一校验不过，整批退回且不留任何痕迹。
export function finishBatch(
  state: AcceptanceState,
  belts: EntryRow[],
  batchId: string,
  now: number,
): FinishOutcome {
  const batch = state.batches[batchId]
  if (!batch) {
    return {
      outcome: 'rolled_back',
      batch: { id: batchId, status: 'rolled_back', createdAt: now, rolledBackAt: now, items: [] },
      message: '验收批次台账丢失，整批退回',
    }
  }
  if (batch.status !== 'processing') {
    return { outcome: 'rolled_back', batch, message: '批次已结束，请勿重复提交' }
  }

  const rollback = (reason: string): FinishOutcome => {
    for (const item of batch.items) {
      const key = String(item.beltId)
      if (state.locks[key]?.batchId === batchId) {
        delete state.locks[key]
      }
    }
    batch.status = 'rolled_back'
    batch.rolledBackAt = now
    batch.rollbackReason = reason
    return { outcome: 'rolled_back', batch, message: reason }
  }

  for (const item of batch.items) {
    const key = String(item.beltId)
    const lock = state.locks[key]
    if (!lock || lock.batchId !== batchId) {
      return rollback('提交时林带验收锁已被其他批次占用，本批整批退回')
    }
    const row = belts.find((belt) => Number(belt.id) === item.beltId)
    if (!row) {
      return rollback('提交时林带记录已不存在，本批整批退回')
    }
    if (String(row.status) !== item.fromStatus) {
      return rollback(
        `林带「${item.beltCode}」在验收期间状态从「${item.fromStatus}」变为「${String(row.status)}」，本批整批退回`,
      )
    }
  }

  let accepted = 0
  let needReplant = 0
  for (const item of batch.items) {
    const key = String(item.beltId)
    const row = belts.find((belt) => Number(belt.id) === item.beltId)!
    row.status = item.toStatus
    row.pending = isPendingAfter(item.toStatus)

    if (item.passed) {
      accepted += 1
      const todo = state.todos[key]
      if (todo && !todo.closed) {
        todo.closed = true
        todo.closedBatchId = batchId
        todo.closedAt = now
      }
    } else {
      needReplant += 1
      const previous = state.todos[key]
      state.todos[key] = {
        beltId: item.beltId,
        beltCode: item.beltCode,
        beltName: item.beltName,
        forest: item.forest,
        sourceBatchId: batchId,
        createdAt: now,
        // 曾经关闭过的待办因新一次不合格验收重新打开。
        closed: false,
      }
      if (previous?.closed) {
        delete previous.closedBatchId
        delete previous.closedAt
      }
    }
    delete state.locks[key]
  }

  batch.status = 'committed'
  batch.committedAt = now
  return { outcome: 'committed', batch, accepted, needReplant }
}

export type BeltView = {
  id: number
  row: EntryRow
  code: string
  name: string
  forest: string
  status: string
  lockedBy: string | null
  latest: { passed: boolean; batchId: string; at: number } | null
  todoActive: boolean
}

export type BatchSummary = {
  id: string
  status: AcceptanceBatch['status']
  createdAt: number
  finishedAt: number
  itemCount: number
  accepted: number
  needReplant: number
  reason?: string
}

export type AcceptanceView = {
  belts: BeltView[]
  recentBatches: BatchSummary[]
  stats: {
    waiting: number
    processing: number
    acceptedTotal: number
    todoActive: number
    todoClosedTotal: number
  }
}

// 队列、导航、明细、总览全部来自这同一次读取的结果，天然对得上。
export function buildAcceptanceView(state: AcceptanceState, belts: EntryRow[]): AcceptanceView {
  const latestByBelt = new Map<number, { passed: boolean; batchId: string; at: number }>()
  for (const batch of Object.values(state.batches)) {
    if (batch.status !== 'committed') {
      continue
    }
    const at = batch.committedAt ?? batch.createdAt
    for (const item of batch.items) {
      const previous = latestByBelt.get(item.beltId)
      if (!previous || at >= previous.at) {
        latestByBelt.set(item.beltId, { passed: item.passed, batchId: batch.id, at })
      }
    }
  }

  const beltViews: BeltView[] = belts.map((row) => {
    const id = Number(row.id)
    const key = String(id)
    return {
      id,
      row,
      code: String(row['林带编号'] ?? ''),
      name: String(row['林带名称'] ?? ''),
      forest: String(row['所属林区'] ?? ''),
      status: String(row.status),
      lockedBy: state.locks[key]?.batchId ?? null,
      latest: latestByBelt.get(id) ?? null,
      todoActive: state.todos[key] ? !state.todos[key].closed : false,
    }
  })

  let acceptedTotal = 0
  for (const latest of latestByBelt.values()) {
    if (latest.passed) {
      acceptedTotal += 1
    }
  }
  const todoList = Object.values(state.todos)

  const recentBatches: BatchSummary[] = Object.values(state.batches)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8)
    .map((batch) => ({
      id: batch.id,
      status: batch.status,
      createdAt: batch.createdAt,
      finishedAt: batch.committedAt ?? batch.rolledBackAt ?? batch.createdAt,
      itemCount: batch.items.length,
      accepted: batch.status === 'committed' ? batch.items.filter((item) => item.passed).length : 0,
      needReplant: batch.status === 'committed' ? batch.items.filter((item) => !item.passed).length : 0,
      reason: batch.rollbackReason,
    }))

  return {
    belts: beltViews,
    recentBatches,
    stats: {
      waiting: beltViews.filter(
        (belt) =>
          (ACCEPTABLE_STATUSES as readonly string[]).includes(belt.status) && !belt.lockedBy,
      ).length,
      processing: Object.keys(state.locks).length,
      acceptedTotal,
      todoActive: todoList.filter((todo) => !todo.closed).length,
      todoClosedTotal: todoList.filter((todo) => todo.closed).length,
    },
  }
}
