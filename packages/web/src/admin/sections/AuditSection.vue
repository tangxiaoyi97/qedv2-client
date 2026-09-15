<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { dateText, type ManagementClient, type Page } from '../api.js';
import { isoInput, query } from '../formats.js';
import { actionLabel, userCountLabels, type Audit, type Capabilities } from '../server-types.js';
import { useRequest } from '../useRequest.js';
import PaginationBar from '../components/PaginationBar.vue';
import RequestState from '../components/RequestState.vue';
import StatusBadge from '../components/StatusBadge.vue';
const props = defineProps<{ client: ManagementClient; capabilities: Capabilities }>();
const emit = defineEmits<{ sessionLost: [] }>();
const { busy, error, run, cancel } = useRequest(props.client, () => emit('sessionLost'));
interface AuthPage { items: Audit[]; page: number; pageSize: number; hasMore: boolean; truncated: boolean }
const source = ref<'operations' | 'auth'>('operations'), result = shallowRef<Page<Audit>>(), auth = shallowRef<AuthPage>();
const filters = reactive({ action: '', targetId: '', outcome: '', from: '', to: '' }), applied = reactive({ action: '', targetId: '', outcome: '', from: '', to: '' });
const metadataLabels: Record<string, string> = { ...Object.fromEntries(Object.entries(userCountLabels).map(([key, value]) => [`count.${key}`, value])), useCount: '已记录使用次数', useCountComplete: '使用次数完整', changed: '状态已改变', kind: '类型', expiresAt: '到期时间', mode: 'AI 模式', monthlyTokenLimit: '每月 Token 上限', monthlyCostLimitCents: '每月费用上限（美分）', from: '原状态', to: '新状态', disabled: '停用', sessionsRevoked: '旧会话失效' };
const actions = computed(() => Object.entries(actionLabel).filter(([key]) => source.value === 'auth' ? key.startsWith('auth.') || ['identity.reset', 'service.restart'].includes(key) : !key.startsWith('auth.') && key !== 'identity.reset'));
function safeMetadata(item: Audit) {
  const values = Object.entries(item.metadata ?? {}).filter(([key, value]) => key in metadataLabels && (value === null || ['string', 'number', 'boolean'].includes(typeof value)));
  const counts = item.metadata?.counts;
  if (counts && typeof counts === 'object' && !Array.isArray(counts)) for (const [key, value] of Object.entries(counts)) if (key in userCountLabels && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) values.push([`count.${key}`, value]);
  return values;
}
async function load(page = result.value?.page ?? auth.value?.page ?? 1) {
  result.value = undefined; auth.value = undefined;
  await run(async (signal) => {
    const parameters = { page, ...(props.capabilities.auditFilters || source.value === 'auth' ? { action: applied.action, from: isoInput(applied.from) ?? '', to: isoInput(applied.to) ?? '', ...(source.value === 'auth' ? { outcome: applied.outcome } : { targetId: applied.targetId.trim() }) } : {}) };
    return props.client.request<Page<Audit> | AuthPage>(query(source.value === 'auth' ? '/auth/audit' : '/audit', parameters), undefined, true, undefined, signal);
  }, (value) => { if ('hasMore' in value) auth.value = value; else result.value = value; });
}
async function filter(reset = false) { if (reset) Object.assign(filters, { action: '', targetId: '', outcome: '', from: '', to: '' }); Object.assign(applied, filters); await load(1); }
async function select(value: typeof source.value) { if (value === 'auth' && !props.capabilities.authAudit) return; source.value = value; await filter(true); }
onMounted(() => load(1));
</script>
<template><div class="panel-toolbar"><h3>日志</h3><button type="button" :disabled="busy" @click="load()">刷新</button></div><div v-if="capabilities.authAudit" class="actions log-selector" role="group" aria-label="日志类型"><button type="button" :aria-pressed="source === 'operations'" @click="select('operations')">管理操作</button><button type="button" :aria-pressed="source === 'auth'" @click="select('auth')">认证与服务</button></div><form v-if="capabilities.auditFilters || source === 'auth'" class="filter-bar filter-fields" @submit.prevent="filter()"><div class="field"><label for="audit-action">操作</label><select id="audit-action" v-model="filters.action"><option value="">全部操作</option><option v-for="[key, label] in actions" :key="key" :value="key">{{ label }}</option></select></div><div v-if="source === 'operations'" class="field"><label for="audit-target">目标 ID</label><input id="audit-target" v-model="filters.targetId" maxlength="128" pattern="[A-Za-z0-9_\-]{1,128}" autocomplete="off" /></div><div v-else class="field"><label for="audit-outcome">结果</label><select id="audit-outcome" v-model="filters.outcome"><option value="">全部结果</option><option value="requested">已请求</option><option value="succeeded">成功</option><option value="failed">失败</option></select></div><div class="field"><label for="audit-from">开始时间（本地）</label><input id="audit-from" v-model="filters.from" type="datetime-local" /></div><div class="field"><label for="audit-to">结束时间（本地，不含）</label><input id="audit-to" v-model="filters.to" type="datetime-local" /></div><button type="submit">筛选</button><button type="button" @click="filter(true)">重置</button></form><RequestState :busy="busy" :error="error" @cancel="cancel" /><p v-if="auth?.truncated" class="field-hint">当前仅显示节点保留的近期日志，更早记录未包含。</p>
<div v-if="result || auth" class="table-wrap" tabindex="0" role="region" aria-label="日志列表，可横向滚动"><table><caption class="sr-only">{{ source === 'auth' ? '认证与服务日志' : '管理操作日志' }}</caption><thead><tr><th scope="col">时间</th><th scope="col">操作</th><th scope="col">操作者</th><th scope="col">{{ source === 'auth' ? '结果' : '目标' }}</th><th v-if="source === 'operations'" scope="col">详情</th></tr></thead><tbody><tr v-for="(item, index) in (result?.items ?? auth?.items)" :key="item.id ?? `${item.at}-${index}`"><td class="date-cell">{{ dateText(item.createdAt ?? item.at) }}</td><td>{{ actionLabel[item.action] ?? item.action }}</td><td>{{ item.actor === 'administrator' ? '管理员' : item.actor ?? '—' }}</td><td><StatusBadge v-if="source === 'auth'" :value="item.outcome" /><span v-else class="mono">{{ item.targetId ?? '—' }}</span></td><td v-if="source === 'operations'"><details v-if="safeMetadata(item).length"><summary>查看</summary><dl class="detail-list metadata-list"><template v-for="[key, value] in safeMetadata(item)" :key="key"><dt>{{ metadataLabels[key] }}</dt><dd>{{ value === null ? '不限' : value === true ? '是' : value === false ? '否' : value }}</dd></template></dl></details><span v-else>—</span></td></tr><tr v-if="!(result?.items ?? auth?.items)?.length"><td :colspan="source === 'auth' ? 4 : 5" class="empty-cell">暂无符合条件的日志。</td></tr></tbody></table></div><PaginationBar v-if="result" :result="result" :busy="busy" @change="load($event)" /><nav v-if="auth" class="pagination" aria-label="认证日志分页"><span>第 {{ auth.page }} 页 · 本页 {{ auth.items.length }} 条</span><div class="actions"><button type="button" :disabled="busy || auth.page <= 1" @click="load(auth.page - 1)">上一页</button><button type="button" :disabled="busy || !auth.hasMore" @click="load(auth.page + 1)">下一页</button></div></nav></template>
