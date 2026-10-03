<template>
  <section class="page" data-module="firebelt-acceptance">
    <header class="page-head">
      <div>
        <h2>防火林带批量验收</h2>
        <p class="page-desc">
          勾选多条待验收林带一次提交；台账、林带状态与补植待办在同一事务里整批落库，
          失败整批退回，同一林带只允许一个验收批次生效。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新结果</button>
        <RouterLink class="btn ghost" to="/replenish">查看补植待办</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="card in statCards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value" :class="card.tone">{{ card.value }}</strong>
      </article>
    </div>

    <div class="accept-grid">
      <section class="pane">
        <header class="pane-head">
          <h3>验收队列</h3>
          <span class="pane-meta">待提交 {{ waitingBelts.length }} 条 · 已勾选 {{ checkedCount }} 条</span>
        </header>
        <div class="pane-toolbar">
          <label class="check-all">
            <input type="checkbox" :checked="allChecked" :disabled="submitting || !waitingBelts.length" @change="toggleAll" />
            全选
          </label>
          <button
            class="btn primary"
            type="button"
            :disabled="submitting || !checkedCount"
            @click="submit"
          >
            {{ submitting ? '验收处理中…' : `批量提交验收（${checkedCount}）` }}
          </button>
        </div>
        <ul class="queue-list">
          <li v-for="belt in waitingBelts" :key="belt.id" class="queue-item">
            <label class="queue-check">
              <input v-model="checkedIds" type="checkbox" :value="belt.id" :disabled="submitting" />
            </label>
            <div class="queue-main">
              <button class="link belt-pick" type="button" @click="selectedId = belt.id">
                {{ belt.code }} · {{ belt.name }}
              </button>
              <span class="queue-sub">{{ belt.forest }} · 当前 {{ belt.status }}</span>
            </div>
            <select v-model="verdicts[String(belt.id)]" :disabled="submitting">
              <option value="pass">合格</option>
              <option value="fail">不合格（转补植）</option>
            </select>
          </li>
          <li v-if="!waitingBelts.length" class="empty-state pane-empty">暂无待验收林带</li>
        </ul>
        <div v-if="lockedBelts.length" class="locked-note">
          {{ lockedBelts.length }} 条林带正被其他验收批次处理，已自动排除：
          {{ lockedBelts.map((belt) => belt.code).join('、') }}
        </div>
      </section>

      <section class="pane">
        <header class="pane-head">
          <h3>林带导航</h3>
          <span class="pane-meta">按所属林区分组</span>
        </header>
        <div class="nav-scroll">
          <div v-for="group in forestGroups" :key="group.forest" class="nav-group">
            <div class="nav-group-head">{{ group.forest || '未划分林区' }}（{{ group.belts.length }}）</div>
            <button
              v-for="belt in group.belts"
              :key="belt.id"
              type="button"
              class="nav-belt"
              :class="{ active: selectedId === belt.id }"
              @click="selectedId = belt.id"
            >
              <span class="nav-belt-code">{{ belt.code }}</span>
              <span class="nav-belt-name">{{ belt.name }}</span>
              <span class="nav-badges">
                <em v-if="belt.lockedBy" class="badge warn">验收中</em>
                <em v-if="belt.todoActive" class="badge fail">待补植</em>
                <em v-if="belt.latest?.passed" class="badge pass">已合格</em>
                <em class="badge" :class="statusTone(belt.status)">{{ belt.status }}</em>
              </span>
            </button>
          </div>
        </div>
      </section>

      <section class="pane">
        <header class="pane-head">
          <h3>明细面板</h3>
        </header>
        <div v-if="selected" class="detail-body">
          <dl class="detail-grid">
            <template v-for="field in detailFields" :key="field.key">
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value }}</dd>
            </template>
            <dt>当前状态</dt>
            <dd><em class="badge" :class="statusTone(selected.status)">{{ selected.status }}</em></dd>
            <dt>验收锁</dt>
            <dd>{{ selected.lockedBy ? `批次 ${shortId(selected.lockedBy)} 处理中` : '空闲，可提交验收' }}</dd>
            <dt>最近验收</dt>
            <dd v-if="selected.latest">
              <em class="badge" :class="selected.latest.passed ? 'pass' : 'fail'">
                {{ selected.latest.passed ? '合格' : '不合格' }}
              </em>
              批次 {{ shortId(selected.latest.batchId) }} · {{ formatTime(selected.latest.at) }}
            </dd>
            <dd v-else class="muted">尚无验收结果</dd>
            <dt>补植待办</dt>
            <dd>
              <em v-if="selected.todoActive" class="badge fail">待补植，已同步至补植待办模块</em>
              <span v-else-if="selected.status === '完好'" class="muted">无待办（最近验收合格时自动关闭）</span>
              <span v-else class="muted">暂无待办</span>
            </dd>
          </dl>
        </div>
        <p v-else class="empty-state pane-empty">从队列或导航选择一条林带查看明细</p>
      </section>
    </div>

    <section class="pane batch-pane">
      <header class="pane-head">
        <h3>最近验收批次</h3>
        <span class="pane-meta">结果只认已提交台账；回滚批次不会计入完成数</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>提交时间</th>
            <th>条数</th>
            <th>合格</th>
            <th>转补植</th>
            <th>状态</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in view.recentBatches" :key="batch.id">
            <td>{{ shortId(batch.id) }}</td>
            <td>{{ formatTime(batch.finishedAt) }}</td>
            <td>{{ batch.itemCount }}</td>
            <td>{{ batch.accepted }}</td>
            <td>{{ batch.needReplant }}</td>
            <td>
              <em class="badge" :class="batchTone(batch.status)">{{ batchStatusLabel(batch.status) }}</em>
            </td>
            <td class="muted">{{ batch.reason ?? '—' }}</td>
          </tr>
          <tr v-if="!view.recentBatches.length">
            <td colspan="7" class="empty-state">还没有提交过验收批次</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
      <span v-else>队列、导航、明细与总览取数均来自同一次读取的已提交结果</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  ACCEPTABLE_STATUSES,
  loadAcceptanceView,
  submitAcceptanceBatch,
  type AcceptanceView,
} from '@/api/acceptance-service'

const view = ref<AcceptanceView>({
  belts: [],
  recentBatches: [],
  stats: { waiting: 0, processing: 0, acceptedTotal: 0, todoActive: 0, todoClosedTotal: 0 },
})
const selectedId = ref<number | null>(null)
const checkedIds = ref<number[]>([])
const verdicts = ref<Record<string, 'pass' | 'fail'>>({})
const submitting = ref(false)
const message = ref('')
const messageOk = ref(false)

const acceptableSet = new Set<string>(ACCEPTABLE_STATUSES)

const waitingBelts = computed(() =>
  view.value.belts.filter((belt) => acceptableSet.has(belt.status) && !belt.lockedBy),
)
const lockedBelts = computed(() => view.value.belts.filter((belt) => belt.lockedBy))
const checkedCount = computed(() =>
  checkedIds.value.filter((id) => waitingBelts.value.some((belt) => belt.id === id)).length,
)
const allChecked = computed(
  () => waitingBelts.value.length > 0 && checkedCount.value === waitingBelts.value.length,
)

const forestGroups = computed(() => {
  const groups = new Map<string, AcceptanceView['belts']>()
  for (const belt of view.value.belts) {
    const list = groups.get(belt.forest) ?? []
    list.push(belt)
    groups.set(belt.forest, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'))
    .map(([forest, belts]) => ({ forest, belts }))
})

const selected = computed(() => view.value.belts.find((belt) => belt.id === selectedId.value) ?? null)

const detailFields = computed(() => {
  const belt = selected.value
  if (!belt) {
    return []
  }
  const labels: Array<[string, string]> = [
    ['编号', '林带编号'],
    ['名称', '林带名称'],
    ['所属林区', '所属林区'],
    ['树种组成', '树种组成'],
    ['林带长度', '林带长度'],
    ['林带宽度', '林带宽度'],
    ['种植年份', '种植年份'],
  ]
  return labels.map(([label, key]) => ({
    key,
    label,
    value: String(belt.row[key] ?? '—'),
  }))
})

const statCards = computed(() => [
  { label: '待验收林带', value: view.value.stats.waiting, tone: '' },
  { label: '处理中（锁定）', value: view.value.stats.processing, tone: 'text-warn' },
  { label: '总览累计验收合格', value: view.value.stats.acceptedTotal, tone: 'text-pass' },
  { label: '补植待办（联动）', value: view.value.stats.todoActive, tone: 'text-fail' },
  { label: '已完成补植', value: view.value.stats.todoClosedTotal, tone: '' },
])

function toggleAll(event: Event) {
  const target = event.target as HTMLInputElement
  checkedIds.value = target.checked ? waitingBelts.value.map((belt) => belt.id) : []
}

async function submit() {
  const selectedEntries = waitingBelts.value.filter((belt) => checkedIds.value.includes(belt.id))
  if (!selectedEntries.length || submitting.value) {
    return
  }
  submitting.value = true
  message.value = ''
  try {
    const result = await submitAcceptanceBatch({
      items: selectedEntries.map((belt) => ({
        beltId: belt.id,
        passed: verdicts.value[String(belt.id)] !== 'fail',
      })),
    })
    messageOk.value = result.ok
    if (result.ok) {
      message.value = `批次 ${shortId(result.batchId)} 整批提交成功：合格 ${result.accepted} 条、转补植 ${result.needReplant} 条。`
      if (result.healed.length) {
        message.value += ` 同时自动退回 ${result.healed.length} 个中断在半路的历史批次。`
      }
    } else {
      message.value = `批次 ${shortId(result.batchId)} 整批退回：${result.message}`
      if (result.healed.length) {
        message.value += `（提交前已自动回滚 ${result.healed.length} 个历史中断批次）`
      }
    }
  } finally {
    submitting.value = false
    reload()
  }
}

function reload() {
  view.value = loadAcceptanceView()
  const validIds = new Set(
    view.value.belts
      .filter((belt) => acceptableSet.has(belt.status) && !belt.lockedBy)
      .map((belt) => belt.id),
  )
  checkedIds.value = checkedIds.value.filter((id) => validIds.has(id))
  for (const belt of view.value.belts) {
    if (!verdicts.value[String(belt.id)]) {
      verdicts.value[String(belt.id)] = 'pass'
    }
  }
  if (selectedId.value && !view.value.belts.some((belt) => belt.id === selectedId.value)) {
    selectedId.value = null
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function formatTime(value: number): string {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function statusTone(status: string): string {
  if (status === '完好') {
    return 'pass'
  }
  if (status === '已退化') {
    return 'muted'
  }
  if (status === '需补植') {
    return 'fail'
  }
  return 'warn'
}

function batchTone(status: string): string {
  if (status === 'committed') {
    return 'pass'
  }
  if (status === 'rolled_back') {
    return 'fail'
  }
  return 'warn'
}

function batchStatusLabel(status: string): string {
  if (status === 'committed') {
    return '已整批提交'
  }
  if (status === 'rolled_back') {
    return '已整批退回'
  }
  return '处理中'
}

onMounted(reload)
</script>

<style scoped>
.accept-grid {
  display: grid;
  grid-template-columns: minmax(300px, 1.1fr) minmax(260px, 1fr) minmax(280px, 1fr);
  gap: 12px;
  align-items: start;
}
.pane {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.pane-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.pane-head h3 {
  margin: 0;
  font-size: 14px;
}
.pane-meta {
  font-size: 12px;
  color: var(--muted);
}
.pane-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.check-all {
  font-size: 13px;
}
.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
}
.queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
}
.queue-main {
  flex: 1;
  min-width: 0;
}
.belt-pick {
  text-align: left;
  font-size: 13px;
}
.queue-sub {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.pane-empty {
  padding: 16px 8px;
}
.locked-note {
  margin-top: 8px;
  font-size: 12px;
  color: #b54708;
  background: #fffaeb;
  border-radius: 6px;
  padding: 6px 8px;
}
.nav-scroll {
  max-height: 460px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nav-group-head {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.nav-belt {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
  margin-bottom: 4px;
}
.nav-belt.active {
  border-color: var(--brand);
  box-shadow: 0 0 0 1px var(--brand) inset;
}
.nav-belt-code {
  font-size: 12px;
  color: var(--muted);
}
.nav-belt-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-badges {
  display: flex;
  gap: 4px;
}
.badge {
  font-style: normal;
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
  background: #eef2f7;
  color: #475569;
  white-space: nowrap;
}
.badge.pass {
  background: #dcfae6;
  color: #067647;
}
.badge.warn {
  background: #fffaeb;
  color: #b54708;
}
.badge.fail {
  background: #fef3f2;
  color: #b42318;
}
.badge.muted {
  background: #f1f5f9;
  color: #94a3b8;
}
.detail-body {
  max-height: 460px;
  overflow-y: auto;
}
.detail-grid {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 6px 10px;
  margin: 0;
  font-size: 13px;
}
.detail-grid dt {
  color: var(--muted);
}
.detail-grid dd {
  margin: 0;
}
.muted {
  color: var(--muted);
}
.batch-pane {
  margin-top: 12px;
}
.text-pass {
  color: #067647;
}
.text-warn {
  color: #b54708;
}
.text-fail {
  color: #b42318;
}
.success-text {
  color: #067647;
}
</style>
