<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { dateText, type Data, type ManagementClient } from './api.js';
import { useRequest } from './useRequest.js';
import ConfirmDialog from './components/ConfirmDialog.vue';
import StatusBadge from './components/StatusBadge.vue';
interface Job { id: string; operation: 'validate' | 'bank-update'; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt?: string; result?: Data; error?: { code: string; message: string } }
interface CoreInfo extends Data { version?: string; commit?: string; health?: Data; bank?: Data; management?: { capabilities?: { validate?: boolean; bankUpdate?: boolean; restart?: boolean; jobHistory?: boolean }; activeJob?: Job | null } }
const props = defineProps<{ client: ManagementClient }>();
const emit = defineEmits<{ sessionLost: []; restart: [] }>();
const info = ref<CoreInfo>(), job = ref<Job>(), history = ref<Job[]>();
const { busy, writing, error, run } = useRequest(props.client, () => emit('sessionLost'));
const confirmAction = ref<'update' | 'restart'>();
const capabilities = computed(() => info.value?.management?.capabilities);
const hasRunningJob = computed(() => job.value?.status === 'running' || info.value?.management?.activeJob?.status === 'running' || history.value?.some((item) => item.status === 'running'));
let poll: ReturnType<typeof setTimeout> | undefined, disposed = false;
function schedulePoll() { clearTimeout(poll); if (!disposed && job.value?.status === 'running') poll = setTimeout(() => { void refreshJob(); }, 2000); }
async function refreshHistory() {
  if (!capabilities.value?.jobHistory) return;
  await run((signal) => props.client.request<{ items: Job[] }>('/jobs', undefined, true, undefined, signal), (value) => { history.value = value.items; });
}
async function refresh() {
  clearTimeout(poll);
  const ok = await run((signal) => props.client.request<CoreInfo>('/info', undefined, true, undefined, signal), (value) => { info.value = value; if (value.management?.activeJob) job.value = value.management.activeJob; });
  if (ok && !disposed) { await refreshHistory(); schedulePoll(); }
}
async function refreshJob(id = job.value?.id) {
  if (!id || disposed || writing.value) return;
  clearTimeout(poll);
  const ok = await run((signal) => props.client.request<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`, undefined, true, undefined, signal), (value) => { job.value = value.job; });
  if (ok && !disposed) { if (job.value?.status === 'running') schedulePoll(); else await refresh(); }
}
async function maintain(operation: 'validate' | 'update' | 'restart') {
  const enabled = operation === 'validate' ? capabilities.value?.validate : operation === 'update' ? capabilities.value?.bankUpdate : capabilities.value?.restart;
  if (enabled !== true) return;
  clearTimeout(poll);
  await run(() => props.client.request<{ job?: Job }>(`/core/${operation}`, {}), (value) => { confirmAction.value = undefined; if (operation === 'restart') emit('restart'); else { job.value = value.job; schedulePoll(); } }, true);
}
const jobLabel = computed(() => job.value?.status === 'running' ? '正在运行' : job.value?.status === 'succeeded' ? '已完成' : '失败');
const resultFields: Record<string, string> = { questionCount: '题目数量', playableCount: '可练习题目', bankCommit: '题库提交', commit: '题库提交', previousCommit: '原题库提交', checkedAt: '校验时间', matchesActiveBank: '与运行题库一致', rootSha256: '题库摘要', schemaSha256: '结构摘要', search: '搜索索引可用', valid: '验证通过', requiresRestart: '需要重启', durability: '保存状态' };
function jobResults() { return Object.entries(job.value?.result ?? {}).filter(([key, value]) => key in resultFields && ['string', 'number', 'boolean'].includes(typeof value)); }
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : '—'; }
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; clearTimeout(poll); });
</script>

<template>
  <div class="panel-toolbar"><h3>节点概览</h3><button type="button" :disabled="busy" @click="refresh">{{ busy ? '正在获取…' : '刷新状态' }}</button></div>
  <p v-if="error && !confirmAction" class="message error" role="alert">{{ error }}</p>
  <div v-if="!info && busy" class="empty-state" role="status">正在获取 Core 节点信息…</div>
  <template v-if="info">
    <div class="metric-grid">
      <div class="metric"><span>Core 版本</span><strong>{{ text(info.version) }}</strong></div>
      <div class="metric"><span>代码提交</span><strong class="mono compact-value">{{ text(info.commit).slice(0, 12) }}</strong></div>
      <div class="metric"><span>服务状态</span><strong>{{ info.health?.status === 'ok' || info.health?.status === 'healthy' || info.health?.ok === true ? '正常' : text(info.health?.status) }}</strong></div>
      <div class="metric"><span>题库提交</span><strong class="mono compact-value">{{ text(info.bank?.commit ?? info.bankCommit).slice(0, 12) }}</strong></div>
    </div>
    <section class="surface"><h3>题库与服务</h3>
      <dl class="detail-list"><dt>题目数量</dt><dd>{{ text(info.bank?.questionCount) }}</dd><dt>可练习题目</dt><dd>{{ text(info.bank?.playableCount) }}</dd><dt>构建时间</dt><dd>{{ dateText(info.builtAt ?? info.buildTime) }}</dd><dt>题库更新</dt><dd>{{ capabilities?.bankUpdate ? '已启用' : '未启用' }}</dd><dt>服务重启</dt><dd>{{ capabilities?.restart ? '已启用' : '未启用' }}</dd></dl>
      <div class="actions"><button type="button" class="primary" :disabled="busy || hasRunningJob || !capabilities?.validate" @click="maintain('validate')">校验题库</button><button type="button" :disabled="busy || hasRunningJob || !capabilities?.bankUpdate" @click="confirmAction = 'update'; error = ''">更新题库</button><button type="button" class="danger" :disabled="busy || hasRunningJob || !capabilities?.restart" @click="confirmAction = 'restart'; error = ''">重启 Core</button></div>
    </section>
  </template>
  <section v-if="job" class="surface" aria-labelledby="job-title">
    <div class="panel-toolbar"><h3 id="job-title">{{ job.operation === 'validate' ? '题库校验' : '题库更新' }}</h3><span class="status-pill" role="status">{{ jobLabel }}</span></div>
    <dl class="detail-list"><dt>任务编号</dt><dd class="mono">{{ job.id }}</dd><dt>开始时间</dt><dd>{{ dateText(job.startedAt) }}</dd><dt>完成时间</dt><dd>{{ dateText(job.finishedAt) }}</dd></dl>
    <p v-if="job.status === 'failed'" class="message error" role="alert">{{ job.operation === 'validate' ? '题库校验失败，当前运行题库未被替换。' : '题库更新失败，当前运行题库已保留。' }}请检查节点日志。</p>
    <p v-else-if="job.status === 'running'" class="muted">关闭页面不会取消任务。</p>
    <p v-else class="message success" role="status">{{ job.result?.requiresRestart === true ? '新题库已就绪，重启 Core 后生效。' : '任务已完成。' }}</p>
    <p v-if="job.result?.durability === 'uncertain'" class="message error" role="alert">新题库已选中，但保存状态未确认。请检查节点存储后再重启。</p>
    <dl v-if="jobResults().length" class="detail-list"><template v-for="[key, value] in jobResults()" :key="key"><dt>{{ resultFields[key] }}</dt><dd>{{ key === 'checkedAt' ? dateText(value) : value === true ? '是' : value === false ? '否' : value === 'confirmed' ? '已确认' : value === 'uncertain' ? '未确认' : value }}</dd></template></dl>
    <button type="button" :disabled="busy" @click="refreshJob()">刷新任务状态</button>
  </section>
  <section v-if="capabilities?.jobHistory" class="surface"><div class="panel-toolbar"><h3>维护任务记录</h3><button type="button" :disabled="busy" @click="refreshHistory">刷新记录</button></div><p class="field-hint">本次服务运行中最近 32 项任务，重启后清空。</p><div class="table-wrap" tabindex="0" role="region" aria-label="Core 维护记录，可横向滚动"><table><caption class="sr-only">Core 维护任务记录</caption><thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">开始时间</th><th scope="col">完成时间</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="item in history" :key="item.id"><td>{{ item.operation === 'validate' ? '题库校验' : '题库更新' }}<small class="record-id mono">{{ item.id }}</small></td><td><StatusBadge :value="item.status" /></td><td>{{ dateText(item.startedAt) }}</td><td>{{ dateText(item.finishedAt) }}</td><td><button type="button" :disabled="busy" @click="refreshJob(item.id)">详情</button></td></tr><tr v-if="history?.length === 0"><td colspan="5" class="empty-cell">暂无维护任务。</td></tr></tbody></table></div></section>
  <ConfirmDialog v-if="confirmAction" :title="confirmAction === 'update' ? '更新题库' : '重启 Core'" :description="confirmAction === 'update' ? '验证成功后准备新题库；重启 Core 后生效。当前服务继续使用原题库。' : '内容服务会短暂中断，恢复后需重新登录管理控制台。'" :confirm-label="confirmAction === 'update' ? '确认更新' : '确认重启'" danger :busy="writing" :error="error" @confirm="maintain(confirmAction!)" @close="confirmAction = undefined; error = ''" />
</template>
