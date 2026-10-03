import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, transactRows } from '@/data/local-store'
import type {
  ActionResult,
  BatchActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 批量动作：整批校验、整批写入、整批退回。批次号由「模块 + 动作 + 记录集合」推出，
// 同一批重复提交拿到同一个号，台账里已有就直接回放原结果，不会重复入账。
export function runBatchAction(key: string, ids: number[], action: string): BatchActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作`, batchId: '', applied: 0, skipped: 0, conflicts: [] }
  }
  const uniqueIds = [...new Set(ids.map(Number))].sort((a, b) => a - b)
  if (uniqueIds.length === 0) {
    return { ok: false, message: `请先勾选要${action}的${meta.entity}`, batchId: '', applied: 0, skipped: 0, conflicts: [] }
  }
  const batchId = `${key}|${action}|${uniqueIds.join('.')}`
  const terminal = meta.statuses[meta.statuses.length - 1]

  return transactRows<BatchActionResult>(key, (current, ledger) => {
    const prior = ledger.find((item) => item.batchId === batchId)
    if (prior) {
      return {
        result: {
          ok: true,
          message: `该批次已于 ${prior.appliedAt} ${action}过，本次按原结果返回，未重复入账`,
          batchId,
          applied: 0,
          skipped: prior.applied + prior.skipped,
          conflicts: [],
        },
      }
    }

    const byId = new Map(current.map((row) => [Number(row.id), row]))
    const missing: number[] = []
    const conflicts: number[] = []
    const blocked: number[] = []
    const applicable: EntryRow[] = []
    const skippedIds: number[] = []

    for (const id of uniqueIds) {
      const row = byId.get(id)
      if (!row) {
        missing.push(id)
        continue
      }
      const status = String(row.status)
      if (status === target) {
        // 已在目标态：台账能查到是别的批次做的，算冲突、整批退回；查不到的
        // 是修复前留下的半批历史数据，按兼容处理跳过，不重复入账。
        const takenByOther = ledger.some(
          (item) => item.batchId !== batchId && item.target === target && item.ids.includes(id),
        )
        if (takenByOther) {
          conflicts.push(id)
        } else {
          skippedIds.push(id)
        }
        continue
      }
      if (status === terminal) {
        blocked.push(id)
        continue
      }
      applicable.push(row)
    }

    if (missing.length > 0 || conflicts.length > 0 || blocked.length > 0) {
      const reasons: string[] = []
      if (missing.length > 0) reasons.push(`记录 ${missing.join('、')} 不存在`)
      if (conflicts.length > 0) reasons.push(`记录 ${conflicts.join('、')} 已被其他批次${action}`)
      if (blocked.length > 0) reasons.push(`记录 ${blocked.join('、')} 已是「${terminal}」`)
      return {
        result: {
          ok: false,
          message: `批量${action}失败：${reasons.join('；')}，本批 ${uniqueIds.length} 条全部保持原状`,
          batchId,
          applied: 0,
          skipped: 0,
          conflicts,
        },
      }
    }

    const applyIds = new Set(applicable.map((row) => Number(row.id)))
    const skipIds = new Set(skippedIds)
    const abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
    // 回到首态（完好）才算办结，其余状态仍挂在补植待办里，运营概览的待处理数由此派生
    const nextPending = target !== meta.statuses[0]
    const rows = current.map((row) => {
      const id = Number(row.id)
      if (applyIds.has(id)) {
        return { ...row, status: target, pending: nextPending, abnormal }
      }
      if (skipIds.has(id)) {
        // 历史半批数据不重复入账，只把待办标志对齐到目标态，让补植待办数反映真实状态
        return { ...row, pending: nextPending }
      }
      return row
    })
    const appliedAt = new Date().toLocaleString('zh-CN', { hour12: false })
    return {
      write: {
        rows,
        ledgerEntry: {
          batchId,
          module: key,
          action,
          target,
          ids: uniqueIds,
          applied: applicable.length,
          skipped: skippedIds.length,
          appliedAt,
        },
      },
      result: {
        ok: true,
        message: skippedIds.length > 0
          ? `${meta.entity}已批量${action} ${applicable.length} 条，当前状态「${target}」；${skippedIds.length} 条此前已在「${target}」，按历史数据兼容跳过`
          : `${meta.entity}已批量${action} ${applicable.length} 条，当前状态「${target}」`,
        batchId,
        applied: applicable.length,
        skipped: skippedIds.length,
        conflicts: [],
      },
    }
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
