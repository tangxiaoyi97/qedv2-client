<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { dateText, errorText, ManagementError, type Data, type ManagementClient } from './api.js';
const props = defineProps<{ client: ManagementClient }>();
const emit = defineEmits<{ sessionLost: []; restart: [] }>();
interface Job { id: string; operation: 'validate' | 'bank-update'; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt?: string; result?: Data; error?: { code: string; message: string } }
interface CoreInfo extends Data { version?: string; commit?: string; health?: Data; bank?: Data; management?: { capabilities?: { validate?: boolean; bankUpdate?: boolean; restart?: boolean }; activeJob?: Job | null } }
const info = ref<CoreInfo>();
const job = ref<Job>();
const busy = ref(false);
const error = ref('');
const confirmAction = ref<'update' | 'restart'>();
const capabilities = computed(() => info.value?.management?.capabilities);
let poll: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

async function run(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await work(); }
  catch (caught) { error.value = errorText(caught); if (!props.client.session) emit('sessionLost'); }
  finally { busy.value = false; }
}
async function refresh(): Promise<void> {
  await run(async () => {
    info.value = await props.client.request<CoreInfo>('/info');
    if (info.value.management?.activeJob) { job.value = info.value.management.activeJob; schedulePoll(); }
  });
}
function schedulePoll(): void {
  clearTimeout(poll);
  if (!disposed && job.value?.status === 'running') poll = setTimeout(() => { void refreshJob(); }, 2000);
}
async function refreshJob(): Promise<void> {
  if (!job.value || disposed) return;
  try {
    const result = await props.client.request<{ job: Job }>(`/jobs/${encodeURIComponent(job.value.id)}`);
    if (disposed) return;
    job.value = result.job;
    if (job.value.status === 'running') schedulePoll();
    else info.value = await props.client.request<CoreInfo>('/info');
  } catch (caught) { error.value = errorText(caught); if (!props.client.session) emit('sessionLost'); }
}
async function maintain(operation: 'validate' | 'update' | 'restart'): Promise<void> {
  confirmAction.value = undefined;
  await run(async () => {
    const enabled = operation === 'validate' ? capabilities.value?.validate : operation === 'update' ? capabilities.value?.bankUpdate : capabilities.value?.restart;
    if (enabled !== true) throw new ManagementError('OPERATION_DISABLED', '该节点未明确开放此管理能力。');
    if (operation === 'restart') {
      await props.client.request('/core/restart', {});
      emit('restart');
    } else {
      const result = await props.client.request<{ job: Job }>(`/core/${operation}`, {});
      job.value = result.job;
      schedulePoll();
    }
  });
}
const jobLabel = computed(() => job.value?.status === 'running' ? '正在运行' : job.value?.status === 'succeeded' ? '已完成' : '失败');
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : '—'; }
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; clearTimeout(poll); });
</script>

<template>
  <div class="panel-toolbar"><h3>节点概览</h3><button type="button" :disabled="busy" @click="refresh">{{ busy ? '正在获取…' : '刷新状态' }}</button></div>
  <p v-if="error" class="message error" role="alert">{{ error }}</p>
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
      <div class="actions"><button type="button" class="primary" :disabled="busy || job?.status === 'running' || !capabilities?.validate" @click="maintain('validate')">校验题库</button><button type="button" :disabled="busy || job?.status === 'running' || !capabilities?.bankUpdate" @click="confirmAction = 'update'">更新题库</button><button type="button" class="danger" :disabled="busy || job?.status === 'running' || !capabilities?.restart" @click="confirmAction = 'restart'">重启 Core</button></div>
      <div v-if="confirmAction" class="confirmation" role="group" :aria-label="confirmAction === 'update' ? '确认更新题库' : '确认重启 Core'">
        <h4>{{ confirmAction === 'update' ? '更新题库？' : '重启 Core？' }}</h4>
        <p>{{ confirmAction === 'update' ? '验证成功后，重启 Core 使新题库生效。' : '内容服务会短暂中断，恢复后需重新登录。' }}</p>
        <div class="actions"><button type="button" :disabled="busy" class="danger" @click="maintain(confirmAction!)">{{ confirmAction === 'update' ? '确认更新' : '确认重启' }}</button><button type="button" @click="confirmAction = undefined">取消</button></div>
      </div>
    </section>
  </template>
  <section v-if="job" class="surface" aria-labelledby="job-title">
    <div class="panel-toolbar"><h3 id="job-title">{{ job.operation === 'validate' ? '题库校验' : '题库更新' }}</h3><span class="status-pill" role="status">{{ jobLabel }}</span></div>
    <dl class="detail-list"><dt>任务编号</dt><dd class="mono">{{ job.id }}</dd><dt>开始时间</dt><dd>{{ dateText(job.startedAt) }}</dd><dt>完成时间</dt><dd>{{ dateText(job.finishedAt) }}</dd></dl>
    <p v-if="job.status === 'failed'" class="message error" role="alert">{{ job.operation === 'validate' ? '题库校验失败，当前运行题库未被替换。' : '题库更新失败，当前运行题库已保留。' }}请检查节点日志。</p>
    <p v-else-if="job.status === 'running'" class="muted">关闭页面不会取消任务。</p>
    <p v-else class="message success" role="status">{{ job.result?.requiresRestart === true ? '新题库已就绪，重启 Core 后生效。' : '任务已完成。' }}</p>
    <p v-if="job.result?.durability === 'uncertain'" class="message error" role="alert">新题库已选中，但保存状态未确认。请检查节点存储后再重启。</p>
    <details v-if="job.result"><summary>查看任务结果</summary><pre class="json-result">{{ JSON.stringify(job.result, null, 2) }}</pre></details>
    <button type="button" :disabled="busy" @click="refreshJob">刷新任务状态</button>
  </section>
</template>
