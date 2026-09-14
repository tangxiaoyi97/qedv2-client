<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { dateText, ManagementError, type Data, type ManagementClient } from './api.js';
import { useRequest } from './useRequest.js';
import { useDetailFocus } from './useDetailFocus.js';
import ConfirmDialog from './components/ConfirmDialog.vue';
import StatusBadge from './components/StatusBadge.vue';
interface Job { id: string; operation: 'validate' | 'bank-update'; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt?: string; result?: Data; error?: { code: string; message: string } }
interface CoreInfo extends Data { version?: string; commit?: string; health?: Data; bank?: Data; management?: { capabilities?: { validate?: boolean; bankUpdate?: boolean; bankUpdateCheck?: boolean; restart?: boolean; jobHistory?: boolean }; activeJob?: Job | null } }
interface BankCheck { currentCommit: string | null; latestCommit: string; pendingCommit: string | null; status: 'up_to_date' | 'update_available' | 'pending_restart'; checkedAt: string; repository: string; ref: string; requiresRestart: boolean }
const props = defineProps<{ client: ManagementClient }>();
const emit = defineEmits<{ sessionLost: []; restart: [] }>();
const info = ref<CoreInfo>(), job = ref<Job>(), history = ref<Job[]>(), activeJob = ref<Job>();
const { busy, writing, error, run } = useRequest(props.client, () => emit('sessionLost'));
const { busy: detailBusy, error: detailError, run: runDetail, cancel: cancelDetail } = useRequest(props.client, () => emit('sessionLost'));
const { error: pollError, run: runPoll, cancel: cancelPoll } = useRequest(props.client, () => emit('sessionLost'));
const { busy: checkBusy, error: checkError, run: runCheck, cancel: cancelCheck } = useRequest(props.client, () => emit('sessionLost'));
const bankCheck = ref<BankCheck>(), updateConfirmation = ref<BankCheck>();
const checkNotice = ref('');
let checkExpiry: ReturnType<typeof setTimeout> | undefined;
const detailOpen = ref(false), selectedJobId = ref<string>();
const historyRegion = ref<HTMLElement>();
const { region: detailRegion, capture, reveal, restore } = useDetailFocus();
const confirmAction = ref<'update' | 'restart'>();
const capabilities = computed(() => info.value?.management?.capabilities);
const hasRunningJob = computed(() => activeJob.value?.status === 'running' || info.value?.management?.activeJob?.status === 'running' || history.value?.some((item) => item.status === 'running'));
const bankActionLabel = computed(() => bankCheck.value?.status === 'up_to_date' ? '重新安装' : '更新题库');
const bankActionEnabled = computed(() => capabilities.value?.bankUpdate && capabilities.value?.bankUpdateCheck && bankCheck.value && bankCheck.value.status !== 'pending_restart' && !checkBusy.value && !busy.value && !hasRunningJob.value);
function clearCheck() { clearTimeout(checkExpiry); bankCheck.value = undefined; updateConfirmation.value = undefined; if (confirmAction.value === 'update') confirmAction.value = undefined; }
async function checkBank() {
  if (writing.value || !capabilities.value?.bankUpdateCheck) return;
  clearCheck(); checkNotice.value = '';
  const ok = await runCheck((signal) => props.client.request<BankCheck>('/core/update-check', undefined, true, undefined, signal), (value) => {
    const commit = (input: unknown) => input === null || typeof input === 'string' && /^[a-f0-9]{40}$/.test(input);
    if (!value || !['up_to_date', 'update_available', 'pending_restart'].includes(value.status) || !/^[a-f0-9]{40}$/.test(value.latestCommit)
      || !commit(value.currentCommit) || !commit(value.pendingCommit) || value.requiresRestart !== (value.pendingCommit !== null)
      || !Number.isFinite(Date.parse(value.checkedAt)) || value.status === 'up_to_date' && value.currentCommit !== value.latestCommit
      || value.status === 'pending_restart' && value.pendingCommit !== value.latestCommit
      || value.status === 'update_available' && (value.currentCommit === value.latestCommit || value.pendingCommit === value.latestCommit)) throw new ManagementError('INVALID_RESPONSE', '题库版本检查结果无效，请重试。');
    bankCheck.value = value;
  });
  if (ok && !disposed) checkExpiry = setTimeout(() => { clearCheck(); checkNotice.value = '版本检查已过期，请重新检查。'; }, 300_000);
}
function openUpdate(event: Event) {
  if (!bankActionEnabled.value || !bankCheck.value) return;
  capture(event); updateConfirmation.value = { ...bankCheck.value }; confirmAction.value = 'update'; error.value = '';
}
function closeConfirm() { confirmAction.value = undefined; updateConfirmation.value = undefined; error.value = ''; }
let poll: ReturnType<typeof setTimeout> | undefined, disposed = false;
function schedulePoll() {
  clearTimeout(poll);
  if (!disposed && activeJob.value?.status === 'running') poll = setTimeout(() => { void refreshActiveJob(); }, 2000);
}
function applyJob(value: Job): Job {
  if (activeJob.value?.id === value.id && activeJob.value.status !== 'running' && value.status === 'running') value = activeJob.value;
  if (history.value) history.value = history.value.map((item) => item.id === value.id ? value : item);
  if (activeJob.value?.id === value.id) {
    activeJob.value = value;
    if (info.value?.management) info.value.management.activeJob = value.status === 'running' ? value : null;
  }
  if (value.error?.code === 'BANK_UPDATE_CHANGED') { clearCheck(); checkNotice.value = '远端题库已变化，请重新检查后再操作。'; }
  return value;
}
async function refreshHistory() {
  if (!capabilities.value?.jobHistory) return;
  await run((signal) => props.client.request<{ items: Job[] }>('/jobs', undefined, true, undefined, signal), (value) => { history.value = value.items; });
}
async function refresh() {
  const firstLoad = !info.value;
  const ok = await run((signal) => props.client.request<CoreInfo>('/info', undefined, true, undefined, signal), (value) => {
    info.value = value;
    if (value.management?.activeJob) {
      activeJob.value = value.management.activeJob;
      if (firstLoad) { job.value = value.management.activeJob; selectedJobId.value = job.value.id; detailOpen.value = true; }
    }
  });
  if (ok && !disposed) { await refreshHistory(); if (!hasRunningJob.value && activeJob.value?.error?.code !== 'BANK_UPDATE_CHANGED') await checkBank(); schedulePoll(); }
}
async function refreshActiveJob() {
  const id = activeJob.value?.id;
  if (!id || disposed) return;
  if (busy.value) { schedulePoll(); return; }
  const ok = await runPoll((signal) => props.client.request<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`, undefined, true, undefined, signal), (value) => {
    const updated = applyJob(value.job);
    if (detailOpen.value && selectedJobId.value === id && !detailBusy.value && !detailError.value) job.value = updated;
  });
  if (disposed) return;
  if (ok && activeJob.value?.status !== 'running') await refresh();
  else schedulePoll();
}
async function refreshJob() {
  const id = selectedJobId.value;
  if (!id || disposed || writing.value) return;
  job.value = undefined;
  const ok = await runDetail((signal) => props.client.request<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`, undefined, true, undefined, signal), (value) => { job.value = applyJob(value.job); });
  if (!disposed && detailOpen.value) { await reveal(); if (ok) schedulePoll(); }
}
async function openJob(id: string, event?: Event) {
  capture(event); selectedJobId.value = id; detailOpen.value = true;
  void reveal();
  await refreshJob();
}
function closeJob() {
  const rowTrigger = [...(historyRegion.value?.querySelectorAll<HTMLButtonElement>('button[data-job-id]') ?? [])].find((item) => item.dataset.jobId === selectedJobId.value);
  cancelDetail(); detailOpen.value = false; job.value = undefined; selectedJobId.value = undefined; detailError.value = '';
  void restore(rowTrigger ?? historyRegion.value);
}
async function maintain(operation: 'validate' | 'update' | 'restart', event?: Event) {
  const enabled = operation === 'validate' ? capabilities.value?.validate : operation === 'update' ? capabilities.value?.bankUpdate : capabilities.value?.restart;
  if (enabled !== true || busy.value || hasRunningJob.value) return;
  const approved = updateConfirmation.value;
  if (operation === 'update' && (!approved || !bankActionEnabled.value || approved.latestCommit !== bankCheck.value?.latestCommit)) return;
  const body = operation === 'update' ? { mode: approved!.status === 'up_to_date' ? 'reinstall' : 'update', expectedCommit: approved!.latestCommit } : {};
  if (event) capture(event);
  clearTimeout(poll); if (operation === 'update') clearTimeout(checkExpiry); cancelPoll(); cancelCheck();
  const ok = await run(() => props.client.request<{ job?: Job }>(`/core/${operation}`, body), (value) => {
    closeConfirm();
    if (operation === 'restart') emit('restart');
    else if (value.job) { cancelDetail(); detailError.value = ''; activeJob.value = value.job; job.value = value.job; selectedJobId.value = value.job.id; detailOpen.value = true; }
  }, true);
  if (operation === 'update') clearCheck();
  if (ok && !disposed && operation !== 'restart') { await reveal(); await refreshHistory(); }
  schedulePoll();
}
const jobSuccess = computed(() => job.value?.result?.changed === false ? job.value.result.reason === 'pending-restart' ? '题库已就绪，重启 Core 后生效；未重复下载。' : '题库已是最新版本，未重复下载。' : job.value?.result?.requiresRestart === true ? job.value.result.action === 'reinstall' ? '题库已重新安装，重启 Core 后生效。' : '新题库已就绪，重启 Core 后生效。' : '任务已完成。');
const jobLabel = computed(() => job.value?.status === 'running' ? '正在运行' : job.value?.status === 'succeeded' ? '已完成' : '失败');
const resultFields: Record<string, string> = { questionCount: '题目数量', playableCount: '可练习题目', bankCommit: '题库提交', commit: '题库提交', previousCommit: '原题库提交', checkedAt: '校验时间', matchesActiveBank: '与运行题库一致', rootSha256: '题库摘要', schemaSha256: '结构摘要', search: '搜索索引可用', valid: '验证通过', requiresRestart: '需要重启', durability: '保存状态' };
function jobResults() { return Object.entries(job.value?.result ?? {}).filter(([key, value]) => key in resultFields && ['string', 'number', 'boolean'].includes(typeof value)); }
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : '—'; }
onMounted(refresh);
onBeforeUnmount(() => { disposed = true; clearTimeout(poll); clearTimeout(checkExpiry); });
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
      <div class="panel-toolbar"><h4>题库版本</h4><button v-if="capabilities?.bankUpdateCheck" type="button" :disabled="checkBusy || busy || hasRunningJob" @click="checkBank">{{ checkBusy ? '正在检查…' : '检查更新' }}</button></div>
      <dl class="detail-list"><dt>当前题库</dt><dd class="mono">{{ text(bankCheck?.currentCommit ?? info.bank?.commit ?? info.bankCommit) }}</dd><dt>最新题库</dt><dd class="mono">{{ checkBusy ? '正在检查…' : bankCheck?.latestCommit ?? '尚未确认' }}</dd><template v-if="bankCheck?.pendingCommit"><dt>待重启题库</dt><dd class="mono">{{ bankCheck.pendingCommit }}</dd></template><template v-if="bankCheck"><dt>检查时间</dt><dd>{{ dateText(bankCheck.checkedAt) }}</dd></template></dl>
      <p v-if="checkError" class="message error" role="alert">{{ checkError }}</p>
      <p v-else-if="checkNotice" class="field-hint" role="status">{{ checkNotice }}</p>
      <p v-else-if="!capabilities?.bankUpdateCheck" class="field-hint">{{ capabilities?.bankUpdate ? '请升级 Core 以检查题库版本。' : '此节点未启用题库更新。' }}</p>
      <p v-else-if="bankCheck" class="message success" role="status">{{ bankCheck.status === 'up_to_date' ? bankCheck.pendingCommit ? '当前运行版为最新，另有待重启题库。' : '已是最新版本。' : bankCheck.status === 'pending_restart' ? '题库已就绪，重启 Core 后生效。' : '有新版本可用。' }}</p>
      <div class="actions"><button type="button" class="primary" :disabled="busy || hasRunningJob || !capabilities?.validate" @click="maintain('validate', $event)">校验题库</button><button v-if="bankCheck?.status !== 'pending_restart'" type="button" :disabled="!bankActionEnabled" @click="openUpdate">{{ bankActionLabel }}</button><button type="button" class="danger" :disabled="busy || hasRunningJob || !capabilities?.restart" @click="confirmAction = 'restart'; error = ''">重启 Core</button></div>
    </section>
  </template>
  <p v-if="pollError" class="message error" role="alert">任务状态未刷新：{{ pollError }}</p>
  <section v-if="detailOpen" ref="detailRegion" class="surface detail-region" tabindex="-1" aria-labelledby="job-title" :aria-busy="detailBusy">
    <div class="panel-toolbar"><h3 id="job-title">维护任务详情</h3><button type="button" @click="closeJob">关闭详情</button></div>
    <p v-if="detailBusy" role="status">正在获取任务详情…</p>
    <p v-if="detailError" class="message error" role="alert">{{ detailError }}</p>
    <template v-if="job">
    <div class="panel-toolbar"><h4>{{ job.operation === 'validate' ? '题库校验' : job.result?.action === 'reinstall' ? '题库重新安装' : '题库更新' }}</h4><span class="status-pill" role="status">{{ jobLabel }}</span></div>
    <dl class="detail-list"><dt>任务编号</dt><dd class="mono">{{ job.id }}</dd><dt>开始时间</dt><dd>{{ dateText(job.startedAt) }}</dd><dt>完成时间</dt><dd>{{ dateText(job.finishedAt) }}</dd></dl>
    <p v-if="job.status === 'failed'" class="message error" role="alert">{{ job.error?.code === 'BANK_UPDATE_CHANGED' ? '远端题库已变化，请重新检查后再操作。' : job.operation === 'validate' ? '题库校验失败，当前运行题库未被替换。请检查节点日志。' : '题库更新失败，当前运行题库已保留。请检查节点日志。' }}</p>
    <p v-else-if="job.status === 'running'" class="muted">关闭页面不会取消任务。</p>
    <p v-else class="message success" role="status">{{ jobSuccess }}</p>
    <p v-if="job.result?.durability === 'uncertain'" class="message error" role="alert">新题库已选中，但保存状态未确认。请检查节点存储后再重启。</p>
    <dl v-if="jobResults().length" class="detail-list"><template v-for="[key, value] in jobResults()" :key="key"><dt>{{ resultFields[key] }}</dt><dd>{{ key === 'checkedAt' ? dateText(value) : value === true ? '是' : value === false ? '否' : value === 'confirmed' ? '已确认' : value === 'uncertain' ? '未确认' : value }}</dd></template></dl>
    </template>
    <button type="button" :disabled="detailBusy || writing" @click="refreshJob()">{{ detailBusy ? '正在获取…' : '刷新任务状态' }}</button>
  </section>
  <section v-if="capabilities?.jobHistory" class="surface"><div class="panel-toolbar"><h3>维护任务记录</h3><button type="button" :disabled="busy" @click="refreshHistory">刷新记录</button></div><p class="field-hint">本次服务运行中最近 32 项任务，重启后清空。</p><div ref="historyRegion" class="table-wrap" tabindex="0" role="region" aria-label="Core 维护记录，可横向滚动"><table><caption class="sr-only">Core 维护任务记录</caption><thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">开始时间</th><th scope="col">完成时间</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="item in history" :key="item.id"><td>{{ item.operation === 'validate' ? '题库校验' : '题库更新' }}<small class="record-id mono">{{ item.id }}</small></td><td><StatusBadge :value="item.status" /></td><td>{{ dateText(item.startedAt) }}</td><td>{{ dateText(item.finishedAt) }}</td><td><button type="button" :data-job-id="item.id" :disabled="busy" @click="openJob(item.id, $event)">详情</button></td></tr><tr v-if="history?.length === 0"><td colspan="5" class="empty-cell">暂无维护任务。</td></tr></tbody></table></div></section>
  <ConfirmDialog v-if="confirmAction" :title="confirmAction === 'update' ? updateConfirmation?.status === 'up_to_date' ? '重新安装题库' : '更新题库' : '重启 Core'" :description="confirmAction === 'update' ? updateConfirmation?.status === 'up_to_date' ? '重新下载并校验当前最新题库；重启 Core 后生效。' : '下载并校验新题库；重启 Core 后生效。当前服务继续使用原题库。' : '内容服务会短暂中断，恢复后需重新登录管理控制台。'" :confirm-label="confirmAction === 'update' ? updateConfirmation?.status === 'up_to_date' ? '确认重新安装' : '确认更新' : '确认重启'" danger :busy="writing" :error="error" @confirm="maintain(confirmAction!)" @close="closeConfirm"><template v-if="confirmAction === 'update' && updateConfirmation"><p class="mono">题库提交：{{ updateConfirmation.latestCommit }}</p><p v-if="updateConfirmation.pendingCommit" class="field-hint">将替换待重启题库：<span class="mono">{{ updateConfirmation.pendingCommit }}</span></p></template></ConfirmDialog>
</template>
