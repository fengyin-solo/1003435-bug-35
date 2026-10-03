/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 批次台账记录：批量动作成功一次记一笔，用来挡住重复提交和跨批次冲突。
export type BatchRecord = {
  /** 批次号：模块 + 动作 + 记录集合的指纹，同一批重复提交拿到同一个号 */
  batchId: string
  module: string
  action: string
  target: string
  ids: number[]
  applied: number
  skipped: number
  appliedAt: string
}

export type BatchActionResult = ActionResult & {
  batchId: string
  /** 本次实际流转的记录数 */
  applied: number
  /** 已在目标状态、按历史数据兼容跳过的记录数 */
  skipped: number
  /** 被其他批次占用、导致整批退回的记录 id */
  conflicts: number[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
