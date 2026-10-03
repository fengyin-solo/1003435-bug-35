<template>
  <section class="page" data-module="firebelt">
    <header class="page-head">
      <div>
        <h2>防火林带管理</h2>
        <p class="page-desc">维护防火林带，围绕林带编号、林带名称、所属林区、树种组成做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火林带</button>
        <button class="btn" type="button" @click="exportRows">导出防火林带清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table nav-table">
      <thead>
        <tr>
          <th>验收</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-focused': focusedRow && Number(focusedRow.id) === Number(row.id) }"
          @click="focusRow(row)"
        >
          <td class="check-cell" @click.stop>
            <input
              type="checkbox"
              :checked="selectedIds.includes(Number(row.id))"
              :disabled="!isBatchEligible(row)"
              :title="isBatchEligible(row) ? '勾选后加入验收队列' : `「${terminalStatus}」不参与验收`"
              @change="toggleSelect(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions" @click.stop>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无防火林带数据，可先登记防火林带</td>
        </tr>
      </tbody>
    </table>

    <div class="panel-row">
      <section class="panel">
        <h3 class="panel-title">验收队列（{{ queueRows.length }} 条）</h3>
        <ul v-if="queueRows.length" class="queue-list">
          <li v-for="row in queueRows" :key="String(row.id)">
            <span>{{ row['林带编号'] }} · {{ row['林带名称'] }} · 当前「{{ row.status }}」</span>
            <button class="link" type="button" @click="toggleSelect(row)">移出</button>
          </li>
        </ul>
        <p v-else class="panel-empty">在上方林带导航里勾选记录，加入验收队列后统一提交</p>
        <div class="panel-actions">
          <button class="btn primary" type="button" :disabled="!queueRows.length" @click="submitBatch('验收通过')">提交验收</button>
          <button class="btn" type="button" :disabled="!queueRows.length" @click="submitBatch('验收退回')">验收退回</button>
          <button class="btn ghost" type="button" :disabled="!queueRows.length" @click="clearQueue">清空队列</button>
        </div>
        <template v-if="batchMessage">
          <p class="batch-message" :class="batchOk ? 'ok-text' : 'error-text'">{{ batchMessage }}</p>
          <p class="batch-meta">批次号：{{ lastBatchId }}</p>
        </template>
      </section>

      <section class="panel">
        <h3 class="panel-title">林带明细</h3>
        <dl v-if="focusedRow" class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ focusedRow[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ focusedRow.status }}</dd>
        </dl>
        <p v-else class="panel-empty">点击林带导航中的任意一行查看明细</p>
      </section>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火林带记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  runBatchAction as applyBatch,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firebelt')
const columns = ["林带编号", "林带名称", "所属林区", "树种组成", "林带长度", "林带宽度", "种植年份", "林带状态"]
const actions = ["安排补植", "确认补植", "标记退化"]
const statuses = ["完好", "有缺株", "需补植", "已退化"]
// 末位状态是终态：已退化的林带不再参与验收
const terminalStatus = statuses[statuses.length - 1]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const batchMessage = ref('')
const batchOk = ref(false)
const lastBatchId = ref('')
const selectedIds = ref<number[]>([])
const focusedId = ref<number | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统计、图例、验收队列、明细面板全部从同一份 rows 派生，批量提交后一次 reload 全部对齐
const stats = computed(() => [
  { label: '林带总数', value: total.value },
  { label: '完好条数', value: countByStatus('完好') },
  { label: '缺株条数', value: countByStatus('有缺株') },
  { label: '补植待办', value: countByStatus('需补植') },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: countByStatus(status),
  })),
)
const queueRows = computed(() => rows.value.filter((row) => selectedIds.value.includes(Number(row.id))))
const focusedRow = computed(() => rows.value.find((row) => Number(row.id) === focusedId.value) ?? null)

function countByStatus(status: string) {
  return rows.value.filter((row) => String(row.status) === status).length
}

function isBatchEligible(row: EntryRow) {
  return String(row.status) !== terminalStatus
}

function toggleSelect(row: EntryRow) {
  const id = Number(row.id)
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function focusRow(row: EntryRow) {
  focusedId.value = Number(row.id)
}

function clearQueue() {
  selectedIds.value = []
}

function submitBatch(action: string) {
  errorMessage.value = ''
  batchMessage.value = ''
  const result = applyBatch(meta.key, selectedIds.value, action)
  batchOk.value = result.ok
  batchMessage.value = result.message
  lastBatchId.value = result.batchId
  if (result.ok) {
    selectedIds.value = []
  }
  // 无论成败都重取一次：失败多半是别的批次先动了数据，队列、导航和明细要对齐最新状态
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火林带登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火林带列表读取失败'
  }
}

onMounted(reload)
</script>
