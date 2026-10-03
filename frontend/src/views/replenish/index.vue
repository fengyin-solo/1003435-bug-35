<template>
  <section class="page" data-module="replenish">
    <header class="page-head">
      <div>
        <h2>补植待办</h2>
        <p class="page-desc">
          待办完全跟着防火林带验收结果变化：验收不合格自动建单或重新打开，复验合格在同一事务里自动关闭，
          不允许手工重复登记。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新待办</button>
        <RouterLink class="btn ghost" to="/firebelt/acceptance">前往林带验收</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待补植</span>
        <strong class="stat-value text-fail">{{ activeTodos.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已随复验合格关闭</span>
        <strong class="stat-value text-pass">{{ closedTodos.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">涉及林区</span>
        <strong class="stat-value">{{ forestCount }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>林带编号 / 名称</span>
        <input v-model="keyword" placeholder="按林带编号或名称检索" />
      </label>
      <label class="filter-item">
        <span>所属林区</span>
        <input v-model="forestKeyword" placeholder="按所属林区检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="active">只看待补植</option>
          <option value="closed">只看已关闭</option>
          <option value="all">全部</option>
        </select>
      </label>
      <button class="btn" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>林带编号</th>
          <th>林带名称</th>
          <th>所属林区</th>
          <th>待办状态</th>
          <th>产生批次</th>
          <th>产生时间</th>
          <th>关闭批次 / 时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in filteredTodos" :key="todo.beltId">
          <td>{{ todo.beltCode }}</td>
          <td>{{ todo.beltName }}</td>
          <td>{{ todo.forest || '—' }}</td>
          <td>
            <em v-if="todo.closed" class="badge pass">已随复验合格关闭</em>
            <em v-else class="badge fail">待补植</em>
          </td>
          <td>{{ shortId(todo.sourceBatchId) }}</td>
          <td>{{ formatTime(todo.createdAt) }}</td>
          <td v-if="todo.closed">{{ shortId(todo.closedBatchId ?? '') }} · {{ formatTime(todo.closedAt ?? 0) }}</td>
          <td v-else class="muted">—</td>
        </tr>
        <tr v-if="!filteredTodos.length">
          <td colspan="7" class="empty-state">暂无匹配的补植待办</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ todos.length }} 条待办记录，数据源与验收台账、林带状态为同一份已提交结果</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listReplenishTodos } from '@/api/acceptance-service'
import type { ReplenishTodo } from '@/data/acceptance'

const todos = ref<ReplenishTodo[]>([])
const keyword = ref('')
const forestKeyword = ref('')
const statusFilter = ref<'active' | 'closed' | 'all'>('active')

const activeTodos = computed(() => todos.value.filter((todo) => !todo.closed))
const closedTodos = computed(() => todos.value.filter((todo) => todo.closed))
const forestCount = computed(() => new Set(activeTodos.value.map((todo) => todo.forest).filter(Boolean)).size)

const filteredTodos = computed(() => {
  const nameKey = keyword.value.trim()
  const forestKey = forestKeyword.value.trim()
  return todos.value.filter((todo) => {
    if (statusFilter.value === 'active' && todo.closed) {
      return false
    }
    if (statusFilter.value === 'closed' && !todo.closed) {
      return false
    }
    if (nameKey && !`${todo.beltCode}${todo.beltName}`.includes(nameKey)) {
      return false
    }
    if (forestKey && !todo.forest.includes(forestKey)) {
      return false
    }
    return true
  })
})

function resetFilters() {
  keyword.value = ''
  forestKeyword.value = ''
  statusFilter.value = 'active'
}

function reload() {
  todos.value = listReplenishTodos()
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

onMounted(reload)
</script>

<style scoped>
.badge {
  font-style: normal;
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
}
.badge.pass {
  background: #dcfae6;
  color: #067647;
}
.badge.fail {
  background: #fef3f2;
  color: #b42318;
}
.text-pass {
  color: #067647;
}
.text-fail {
  color: #b42318;
}
.muted {
  color: var(--muted);
}
</style>
