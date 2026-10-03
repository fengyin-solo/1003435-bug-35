import {
  ACCEPTANCE_STATE_KEY,
  ACCEPTABLE_STATUSES,
  buildAcceptanceView,
  claimBatch,
  ensureAcceptanceState,
  finishBatch,
  healInterruptedBatches,
  normalizeAcceptanceState,
  PROCESSING_TTL_MS,
  type AcceptanceView,
  type ClaimOutcome,
  type FinishOutcome,
  type HealNotice,
  type ReplenishTodo,
} from '@/data/acceptance'
import { mutateState, readState } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const MODULE_KEY = 'firebelt'
// 模拟验收处理耗时：锁在这段时间内生效，正好覆盖并发批次。
const PROCESSING_DELAY_MS = 500

export type { AcceptanceView }

export type SubmitResult =
  | {
      ok: true
      batchId: string
      accepted: number
      needReplant: number
      // 提交前顺带修复的历史中断批次。
      healed: HealNotice[]
    }
  | { ok: false; batchId: string; message: string; healed: HealNotice[] }

export type BatchSubmitInput = {
  batchId?: string
  items: Array<{ beltId: number; passed: boolean }>
}

function snapshotState(): { state: ReturnType<typeof normalizeAcceptanceState>; belts: EntryRow[] } {
  const all = readState()
  return {
    state: normalizeAcceptanceState(all[ACCEPTANCE_STATE_KEY]),
    belts: ((all[MODULE_KEY] ?? []) as EntryRow[]).map((row) => ({ ...row })),
  }
}

// 被动自愈：读页面时若发现超过租约仍停在处理中的批次，按历史中断整批退回，
// 队列、导航、总览就不会被永久挂住的旧锁挡住。
function healIfStale(): void {
  const probe = snapshotState().state
  const now = Date.now()
  const hasStale = Object.values(probe.batches).some(
    (batch) => batch.status === 'processing' && now - batch.createdAt > PROCESSING_TTL_MS,
  )
  if (!hasStale) {
    return
  }
  mutateState((draft) => {
    const belts = draft[MODULE_KEY] as EntryRow[] | undefined
    if (!Array.isArray(belts)) {
      return
    }
    const state = ensureAcceptanceState(draft)
    healInterruptedBatches(state, belts, now)
  })
}

// 队列 / 导航 / 明细 / 统计共用这一次取数，杜绝各自取数读到中间态。
export function loadAcceptanceView(): AcceptanceView {
  healIfStale()
  const { state, belts } = snapshotState()
  return buildAcceptanceView(state, belts)
}

export function listReplenishTodos(): ReplenishTodo[] {
  healIfStale()
  const { state } = snapshotState()
  return Object.values(state.todos).sort((a, b) => {
    if (a.closed !== b.closed) {
      return a.closed ? 1 : -1
    }
    return b.createdAt - a.createdAt
  })
}

function generateBatchId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `batch-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 批量提交验收：
// 1) 同一事务里先修复中断的历史批次（整批退回）；
// 2) 同批次 id 幂等，重复提交不会再产生一份结果；
// 3) 抢林带锁，同一林带被两个批次并发处理时只允许先到的一方落锁，另一方整批退回；
// 4) 处理结束再在同一事务里做版本校验并提交，林带状态 / 台账 / 补植待办一次落库；
//    校验失败整批退回，总览完成数只由已提交台账派生，绝不跟着过程涨。
export async function submitAcceptanceBatch(input: BatchSubmitInput): Promise<SubmitResult> {
  const batchId = input.batchId?.trim() || generateBatchId()
  const items = input.items.map((item) => ({ beltId: Number(item.beltId), passed: Boolean(item.passed) }))

  // 阶段一：修复历史 + 登记批次 + 抢锁，单事务。结果用闭包带出，不进存储。
  let healed: HealNotice[] = []
  let claimResult!: ClaimOutcome
  try {
    mutateState((draft) => {
      const belts = draft[MODULE_KEY] as EntryRow[] | undefined
      if (!Array.isArray(belts)) {
        throw new Error('防火林带数据缺失，无法提交验收')
      }
      const state = ensureAcceptanceState(draft)
      healed = healInterruptedBatches(state, belts, Date.now())
      claimResult = claimBatch(state, belts, { batchId, items }, Date.now())
    })
  } catch (error) {
    return {
      ok: false,
      batchId,
      healed,
      message: error instanceof Error ? error.message : '验收批次登记失败，整批未提交',
    }
  }

  if (claimResult.outcome === 'rejected') {
    return { ok: false, batchId, message: claimResult.message, healed }
  }
  if (claimResult.outcome === 'duplicate_committed') {
    const batch = claimResult.batch
    return {
      ok: true,
      batchId,
      accepted: batch.items.filter((item) => item.passed).length,
      needReplant: batch.items.filter((item) => !item.passed).length,
      healed,
    }
  }
  if (claimResult.outcome === 'duplicate_in_flight') {
    return { ok: false, batchId, message: '该批次正在验收处理中，请勿重复提交，处理结果只入账一次', healed }
  }
  if (claimResult.outcome === 'duplicate_rolled_back') {
    return { ok: false, batchId, message: '该批次此前已整批退回，请使用新批次重新提交验收', healed }
  }

  // 处理窗口：锁已持有，其他批次碰到同一林带会在此期间被挡回去。
  await delay(PROCESSING_DELAY_MS)

  // 阶段二：版本校验 + 一次性提交（或整批退回），单事务。
  let finishResult!: FinishOutcome
  mutateState((draft) => {
    const belts = draft[MODULE_KEY] as EntryRow[]
    const state = ensureAcceptanceState(draft)
    finishResult = finishBatch(state, belts, batchId, Date.now())
  })

  if (finishResult.outcome === 'committed') {
    return {
      ok: true,
      batchId,
      accepted: finishResult.accepted,
      needReplant: finishResult.needReplant,
      healed,
    }
  }
  return { ok: false, batchId, message: finishResult.message, healed }
}

export { ACCEPTABLE_STATUSES }
