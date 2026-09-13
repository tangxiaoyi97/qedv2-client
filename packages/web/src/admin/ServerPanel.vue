<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { dateText, errorText, numberText, ManagementError, type Data, type ManagementClient, type Page } from './api.js';
const props = defineProps<{ client: ManagementClient }>();
const emit = defineEmits<{ sessionLost: []; restart: [] }>();
type Tab = 'overview' | 'users' | 'invites' | 'usage' | 'feedback' | 'audit';
type FeedbackStatus = 'open' | 'in_progress' | 'resolved';
interface Allowance { mode: 'BYO' | 'POOL' | 'BOTH'; monthlyTokenLimit: number | null; monthlyCostLimitCents: number | null; usedTokens: number; usedCostCents: number; expiresAt: string | null; periodStart?: string | null }
interface User { id: string; username: string; createdAt: string; archiveVersion: number; lastSyncWrite: string | null; ai: Allowance | null }
interface Invite { id: string; code: string; kind: string; status: string; createdAt: string; expiresAt: string | null }
interface Feedback { id: string; user: { username: string }; category: string; status: FeedbackStatus; subject: string; message: string; createdAt: string; clientVersion?: string; platform?: string; questionId?: string; requestId?: string }
interface Audit { id: string; actor: string; action: string; targetId?: string; createdAt: string; metadata?: Data }
interface Stats { users: { total: number; newLast7Days: number }; activity: { reportedUsersLast7Days: number; attemptsLast7Days: number }; ai: { callsLast7Days: number; failedLast7Days: number; poolCostCentsLast7Days: number }; feedback: { open: number; inProgress: number; resolved: number } }
interface UsageDay { date: string; calls: number; failed: number; inputTokens: number; outputTokens: number; poolCostCents: number }
interface Usage extends UsageDay { days: number; byoEstimatedCostCents: number; byDay: UsageDay[] }
type Capability = 'users' | 'invites' | 'aiAllowance' | 'aiUsage' | 'feedback' | 'audit' | 'restart';
interface ServerInfo extends Data { version?: string; commit?: string; database?: { connected?: boolean; status?: string }; management?: { capabilities?: Partial<Record<Capability, boolean>> } }
const tabs: { id: Tab; label: string }[] = [{ id: 'overview', label: '概览' }, { id: 'users', label: '用户' }, { id: 'invites', label: '邀请码' }, { id: 'usage', label: 'AI 用量' }, { id: 'feedback', label: '反馈' }, { id: 'audit', label: '操作记录' }];
const tab = ref<Tab>('overview');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const info = ref<ServerInfo>();
const stats = ref<Stats>();
const users = ref<Page<User>>();
const invites = ref<Page<Invite>>();
const feedback = ref<Page<Feedback>>();
const audit = ref<Page<Audit>>();
const usage = ref<Usage>();
const page = ref(1);
const search = ref('');
const days = ref(7);
const feedbackFilter = ref('');
const selectedFeedback = ref<Feedback>();
const feedbackEditStatus = ref<FeedbackStatus>('open');
const selectedUser = ref<User>();
const quota = reactive({ mode: 'BYO' as Allowance['mode'], tokens: '', cents: '', expires: '' });
const creatingUser = reactive({ username: '', password: '' });
const generatedPassword = ref('');
const creatingInvite = reactive({ kind: 'once', code: '', expires: '' });
const generatedInvite = ref('');
const restartConfirm = ref(false);
const pageResult = computed(() => ({ users: users.value, invites: invites.value, feedback: feedback.value, audit: audit.value }[tab.value as 'users']));
const statusLabel: Record<string, string> = { open: '待处理', in_progress: '处理中', resolved: '已解决', active: '有效', used: '已使用', expired: '已过期' };
const categoryLabel: Record<string, string> = { bug: '软件问题', question: '题目问题', suggestion: '功能建议' };
const actionLabel: Record<string, string> = { 'user.create': '创建用户', 'invite.create': '创建邀请码', 'ai.allowance.update': '调整 AI 额度', 'feedback.status.update': '更新反馈状态', 'service.restart': '重启服务' };
function can(capability: Capability): boolean { return info.value?.management?.capabilities?.[capability] === true; }
function requireCapability(capability: Capability): void {
  if (!can(capability)) throw new ManagementError('OPERATION_DISABLED', '该节点未明确开放此管理能力。请检查节点版本与配置。');
}
function availableTab(value: Tab): boolean {
  return value === 'overview' || can(value === 'usage' ? 'aiUsage' : value);
}
function count(value: unknown): string { return numberText(value); }
function iso(value: string): string | null { return value ? new Date(value).toISOString() : null; }
function dateInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
async function run(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await work(); }
  catch (caught) { error.value = errorText(caught); if (!props.client.session) emit('sessionLost'); }
  finally { busy.value = false; }
}
async function load(): Promise<void> {
  switch (tab.value) {
    case 'overview': {
      // Version and restart controls remain available even if database stats fail.
      info.value = await props.client.request<ServerInfo>('/info');
      stats.value = await props.client.request<Stats>('/stats');
      break;
    }
    case 'users': users.value = await props.client.request(`/users?page=${page.value}&q=${encodeURIComponent(search.value.trim())}`); break;
    case 'invites': invites.value = await props.client.request(`/invites?page=${page.value}`); break;
    case 'usage': usage.value = await props.client.request(`/ai/usage?days=${days.value}`); break;
    case 'feedback': feedback.value = await props.client.request(`/feedback?page=${page.value}${feedbackFilter.value ? `&status=${feedbackFilter.value}` : ''}`); break;
    case 'audit': audit.value = await props.client.request(`/audit?page=${page.value}`); break;
  }
}
async function selectTab(value: Tab): Promise<void> {
  if (!availableTab(value)) return;
  tab.value = value; page.value = 1; selectedFeedback.value = undefined; selectedUser.value = undefined; generatedPassword.value = ''; generatedInvite.value = '';
  await run(load);
}
async function paginate(change: number): Promise<void> { page.value += change; await run(load); }
async function filter(): Promise<void> { page.value = 1; await run(load); }
async function createUser(): Promise<void> {
  await run(async () => {
    try {
      requireCapability('users');
      const result = await props.client.request<{ user: User; generatedPassword?: string }>('/users', { username: creatingUser.username.trim(), ...(creatingUser.password ? { password: creatingUser.password } : {}) });
      generatedPassword.value = result.generatedPassword ?? '';
      notice.value = `用户 ${result.user.username} 已创建。`;
      creatingUser.username = ''; await load();
    } finally { creatingUser.password = ''; }
  });
}
async function createInvite(): Promise<void> {
  await run(async () => {
    requireCapability('invites');
    const result = await props.client.request<Invite>('/invites', { kind: creatingInvite.kind, ...(creatingInvite.kind === 'permanent' ? { code: creatingInvite.code.trim() } : {}), expiresAt: iso(creatingInvite.expires) });
    generatedInvite.value = result.code; creatingInvite.code = ''; notice.value = '邀请码已创建。'; await load();
  });
}
async function editQuota(user: User): Promise<void> {
  await run(async () => {
    requireCapability('aiAllowance');
    const value = await props.client.request<Allowance>(`/users/${encodeURIComponent(user.id)}/ai`);
    selectedUser.value = { ...user, ai: value };
    quota.mode = value.mode; quota.tokens = value.monthlyTokenLimit?.toString() ?? ''; quota.cents = value.monthlyCostLimitCents?.toString() ?? ''; quota.expires = dateInput(value.expiresAt);
  });
}
async function saveQuota(): Promise<void> {
  await run(async () => {
    requireCapability('aiAllowance');
    if (!selectedUser.value) return;
    await props.client.request(`/users/${encodeURIComponent(selectedUser.value.id)}/ai`, { mode: quota.mode, monthlyTokenLimit: quota.tokens === '' ? null : Number(quota.tokens), monthlyCostLimitCents: quota.cents === '' ? null : Number(quota.cents), expiresAt: iso(quota.expires) }, true, 'PUT');
    selectedUser.value = undefined; notice.value = 'AI 授权已保存。'; await load();
  });
}
function openFeedback(item: Feedback): void { selectedFeedback.value = item; feedbackEditStatus.value = item.status; }
async function saveFeedback(): Promise<void> {
  await run(async () => {
    requireCapability('feedback');
    if (!selectedFeedback.value) return;
    await props.client.request(`/feedback/${encodeURIComponent(selectedFeedback.value.id)}`, { status: feedbackEditStatus.value }, true, 'PATCH');
    selectedFeedback.value = undefined; notice.value = '反馈状态已更新。'; await load();
  });
}
async function restart(): Promise<void> {
  await run(async () => { requireCapability('restart'); await props.client.request('/server/restart', {}); emit('restart'); });
}
onMounted(() => run(load));
</script>

<template>
  <nav class="section-nav" aria-label="Server 管理功能"><button v-for="item in tabs" :key="item.id" type="button" :aria-pressed="tab === item.id" :disabled="busy || !availableTab(item.id)" :title="availableTab(item.id) ? undefined : '该节点未开放此能力'" @click="selectTab(item.id)">{{ item.label }}</button></nav>
  <div class="panel-toolbar"><h3>{{ tabs.find((item) => item.id === tab)?.label }}</h3><button type="button" :disabled="busy" @click="run(load)">{{ busy ? '正在加载…' : '刷新' }}</button></div>
  <p v-if="error" class="message error" role="alert">{{ error }}</p><p v-if="notice" class="message success" role="status">{{ notice }}</p>
  <template v-if="tab === 'overview'">
    <div v-if="stats" class="metric-grid"><div class="metric"><span>总用户</span><strong>{{ count(stats.users.total) }}</strong><small>近 7 天新增 {{ count(stats.users.newLast7Days) }}</small></div><div class="metric"><span>近 7 天上报练习</span><strong>{{ count(stats.activity.attemptsLast7Days) }}</strong><small>{{ count(stats.activity.reportedUsersLast7Days) }} 个已登录账号</small></div><div class="metric"><span>近 7 天 AI 请求</span><strong>{{ count(stats.ai.callsLast7Days) }}</strong><small>失败 {{ count(stats.ai.failedLast7Days) }} 次</small></div><div class="metric"><span>待处理反馈</span><strong>{{ count(stats.feedback.open) }}</strong><small>处理中 {{ count(stats.feedback.inProgress) }}</small></div></div>
    <section v-if="info" class="surface"><h3>服务信息</h3><dl class="detail-list"><dt>Server 版本</dt><dd>{{ info.version ?? '—' }}</dd><dt>代码提交</dt><dd class="mono">{{ info.commit ?? '—' }}</dd><dt>数据库</dt><dd>{{ info.database?.connected === true || info.database?.status === 'connected' ? '已连接' : info.database?.connected === false || info.database?.status === 'down' ? '未连接' : '—' }}</dd><dt>共享池费用 · 近 7 天</dt><dd>{{ count(stats?.ai.poolCostCentsLast7Days) }} 美分</dd></dl>
      <button type="button" class="danger" :disabled="busy || !info.management?.capabilities?.restart" @click="restartConfirm = true">重启 Server</button><p v-if="!info.management?.capabilities?.restart" class="field-hint">该节点未启用远程重启。</p>
      <div v-if="restartConfirm" class="confirmation"><h4>重启 Server？</h4><p>登录、同步和 AI 服务会短暂中断，恢复后需重新登录。</p><div class="actions"><button type="button" class="danger" :disabled="busy" @click="restart">确认重启</button><button type="button" @click="restartConfirm = false">取消</button></div></div>
    </section>
  </template>
  <template v-if="tab === 'users'">
    <form class="filter-bar" @submit.prevent="filter"><label for="user-search">搜索用户名</label><input id="user-search" v-model="search" type="search" maxlength="32" placeholder="输入用户名" /><button type="submit" :disabled="busy">搜索</button></form>
    <details class="surface"><summary>创建用户</summary><form class="form-grid" @submit.prevent="createUser"><div class="field"><label for="new-username">用户名</label><input id="new-username" v-model="creatingUser.username" required minlength="3" maxlength="32" autocomplete="off" /></div><div class="field"><label for="new-user-password">初始密码（选填）</label><input id="new-user-password" v-model="creatingUser.password" type="password" minlength="8" maxlength="256" autocomplete="new-password" /><p class="field-hint">留空自动生成，仅显示一次。</p></div><div class="actions form-wide"><button type="submit" class="primary" :disabled="busy || !can('users')">创建用户</button></div></form></details>
    <div v-if="generatedPassword" class="message success"><p>请保存新用户的初始密码：</p><code class="generated-secret">{{ generatedPassword }}</code><button type="button" @click="generatedPassword = ''">已保存，隐藏密码</button></div>
    <form v-if="selectedUser" class="surface" @submit.prevent="saveQuota"><div class="panel-toolbar"><h3>{{ selectedUser.username }} · AI 授权</h3><button type="button" @click="selectedUser = undefined">关闭</button></div><p class="muted">已用 {{ count(selectedUser.ai?.usedTokens) }} Token / {{ count(selectedUser.ai?.usedCostCents) }} 美分。</p><div class="form-grid"><div class="field"><label for="quota-mode">授权模式</label><select id="quota-mode" v-model="quota.mode"><option value="BYO">仅用户自己的密钥</option><option value="POOL">共享池</option><option value="BOTH">自己的密钥和共享池</option></select></div><div class="field"><label for="quota-tokens">每月 Token 上限</label><input id="quota-tokens" v-model="quota.tokens" type="number" min="0" max="2147483647" step="1" placeholder="留空表示不限" aria-describedby="quota-token-hint" /><p id="quota-token-hint" class="field-hint">留空不限；0 禁用共享池。</p></div><div class="field"><label for="quota-cents">每月费用上限（美分）</label><input id="quota-cents" v-model="quota.cents" type="number" min="0" max="2147483647" step="1" placeholder="留空表示不限" aria-describedby="quota-cost-hint" /><p id="quota-cost-hint" class="field-hint">留空不限；0 禁用共享池。</p></div><div class="field"><label for="quota-expires">到期时间（本地时间，选填）</label><input id="quota-expires" v-model="quota.expires" type="datetime-local" /></div></div><div class="actions"><button type="submit" class="primary" :disabled="busy || !can('aiAllowance')">保存授权</button><button type="button" @click="selectedUser = undefined">取消</button></div></form>
    <div class="table-wrap"><table><caption class="sr-only">用户列表</caption><thead><tr><th>用户</th><th>创建时间</th><th>最近同步写入</th><th>AI 模式</th><th>操作</th></tr></thead><tbody><tr v-for="user in users?.items" :key="user.id"><td><strong>{{ user.username }}</strong><small class="record-id mono">{{ user.id }}</small></td><td>{{ dateText(user.createdAt) }}</td><td>{{ dateText(user.lastSyncWrite) }}</td><td>{{ user.ai?.mode ?? 'BYO' }}</td><td><button type="button" :disabled="busy || !can('aiAllowance')" :aria-label="`管理 ${user.username} 的 AI 授权`" @click="editQuota(user)">AI 授权</button></td></tr><tr v-if="users?.items.length === 0"><td colspan="5" class="empty-cell">暂无符合条件的用户。</td></tr></tbody></table></div>
  </template>
  <template v-if="tab === 'invites'">
    <details class="surface"><summary>创建邀请码</summary><form @submit.prevent="createInvite"><div class="form-grid"><div class="field"><label for="invite-kind">类型</label><select id="invite-kind" v-model="creatingInvite.kind"><option value="once">一次性邀请码</option><option value="permanent">可重复使用邀请码</option></select></div><div v-if="creatingInvite.kind === 'permanent'" class="field"><label for="invite-code">自定义邀请码</label><input id="invite-code" v-model="creatingInvite.code" required minlength="4" maxlength="64" autocomplete="off" /></div><div class="field"><label for="invite-expires">到期时间（本地时间，选填）</label><input id="invite-expires" v-model="creatingInvite.expires" type="datetime-local" /></div></div><button type="submit" class="primary" :disabled="busy || !can('invites')">创建邀请码</button></form></details>
    <p v-if="generatedInvite" class="message success">已创建：<code class="generated-secret">{{ generatedInvite }}</code></p>
    <div class="table-wrap"><table><caption class="sr-only">邀请码列表</caption><thead><tr><th>邀请码</th><th>类型</th><th>状态</th><th>创建时间</th><th>到期时间</th></tr></thead><tbody><tr v-for="invite in invites?.items" :key="invite.id"><td class="mono">{{ invite.code }}</td><td>{{ invite.kind === 'once' ? '一次性' : '可重复使用' }}</td><td>{{ statusLabel[invite.status] ?? invite.status }}</td><td>{{ dateText(invite.createdAt) }}</td><td>{{ dateText(invite.expiresAt) }}</td></tr><tr v-if="invites?.items.length === 0"><td colspan="5" class="empty-cell">暂无邀请码。</td></tr></tbody></table></div>
  </template>
  <template v-if="tab === 'usage'">
    <form class="filter-bar" @submit.prevent="run(load)"><label for="usage-days">时间范围</label><select id="usage-days" v-model.number="days"><option :value="7">近 7 天</option><option :value="30">近 30 天</option><option :value="90">近 90 天</option></select><button type="submit" :disabled="busy">查询</button></form>
    <div v-if="usage" class="metric-grid"><div class="metric"><span>AI 请求</span><strong>{{ count(usage.calls) }}</strong><small>失败 {{ count(usage.failed) }} 次</small></div><div class="metric"><span>输入 / 输出 Token</span><strong class="compact-value">{{ count(usage.inputTokens) }} / {{ count(usage.outputTokens) }}</strong></div><div class="metric"><span>共享池费用（美分）</span><strong>{{ count(usage.poolCostCents) }}</strong></div><div class="metric"><span>用户密钥估算费用（美分）</span><strong>{{ count(usage.byoEstimatedCostCents) }}</strong></div></div>
    <div class="table-wrap"><table><caption class="sr-only">每日 AI 用量</caption><thead><tr><th>日期（UTC）</th><th>请求</th><th>失败</th><th>输入 Token</th><th>输出 Token</th><th>共享池费用（美分）</th></tr></thead><tbody><tr v-for="day in usage?.byDay" :key="day.date"><td>{{ day.date }}</td><td>{{ count(day.calls) }}</td><td>{{ count(day.failed) }}</td><td>{{ count(day.inputTokens) }}</td><td>{{ count(day.outputTokens) }}</td><td>{{ count(day.poolCostCents) }}</td></tr><tr v-if="usage?.byDay.length === 0"><td colspan="6" class="empty-cell">该时间范围内没有 AI 调用。</td></tr></tbody></table></div>
  </template>
  <template v-if="tab === 'feedback'">
    <form class="filter-bar" @submit.prevent="filter"><label for="feedback-filter">处理状态</label><select id="feedback-filter" v-model="feedbackFilter"><option value="">全部状态</option><option value="open">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select><button type="submit" :disabled="busy">筛选</button></form>
    <section v-if="selectedFeedback" class="surface feedback-detail"><div class="panel-toolbar"><h3>{{ selectedFeedback.subject }}</h3><button type="button" @click="selectedFeedback = undefined">关闭详情</button></div><p class="muted">{{ selectedFeedback.user.username }} · {{ categoryLabel[selectedFeedback.category] }} · {{ dateText(selectedFeedback.createdAt) }}</p><p class="feedback-message">{{ selectedFeedback.message }}</p><dl class="detail-list"><dt>客户端 / 平台</dt><dd>{{ selectedFeedback.clientVersion ?? '—' }} / {{ selectedFeedback.platform ?? '—' }}</dd><dt>题目 ID</dt><dd class="mono">{{ selectedFeedback.questionId ?? '—' }}</dd><dt>请求 ID</dt><dd class="mono">{{ selectedFeedback.requestId ?? '—' }}</dd></dl><form class="filter-bar" @submit.prevent="saveFeedback"><label for="feedback-status">处理状态</label><select id="feedback-status" v-model="feedbackEditStatus"><option value="open">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select><button type="submit" class="primary" :disabled="busy || !can('feedback')">保存状态</button></form></section>
    <div class="table-wrap"><table><caption class="sr-only">反馈列表</caption><thead><tr><th>主题</th><th>用户</th><th>类型</th><th>状态</th><th>提交时间</th></tr></thead><tbody><tr v-for="item in feedback?.items" :key="item.id"><td><button type="button" class="link-button" @click="openFeedback(item)">{{ item.subject }}</button></td><td>{{ item.user.username }}</td><td>{{ categoryLabel[item.category] ?? item.category }}</td><td>{{ statusLabel[item.status] }}</td><td>{{ dateText(item.createdAt) }}</td></tr><tr v-if="feedback?.items.length === 0"><td colspan="5" class="empty-cell">暂无符合条件的反馈。</td></tr></tbody></table></div>
  </template>
  <template v-if="tab === 'audit'">
    <div class="table-wrap"><table><caption class="sr-only">管理操作记录</caption><thead><tr><th>时间</th><th>操作</th><th>操作者</th><th>目标</th><th>详情</th></tr></thead><tbody><tr v-for="item in audit?.items" :key="item.id"><td>{{ dateText(item.createdAt) }}</td><td>{{ actionLabel[item.action] ?? item.action }}</td><td>{{ item.actor }}</td><td class="mono">{{ item.targetId ?? '—' }}</td><td><details v-if="item.metadata && Object.keys(item.metadata).length"><summary>查看</summary><pre class="json-result">{{ JSON.stringify(item.metadata, null, 2) }}</pre></details><span v-else>—</span></td></tr><tr v-if="audit?.items.length === 0"><td colspan="5" class="empty-cell">暂无操作记录。</td></tr></tbody></table></div>
  </template>
  <div v-if="pageResult" class="pagination"><span>共 {{ count(pageResult.total) }} 条 · 第 {{ page }} 页</span><div class="actions"><button type="button" :disabled="busy || page <= 1" @click="paginate(-1)">上一页</button><button type="button" :disabled="busy || page * pageResult.pageSize >= pageResult.total" @click="paginate(1)">下一页</button></div></div>
</template>
