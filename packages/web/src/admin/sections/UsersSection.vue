<script setup lang="ts">
import { onMounted, reactive, ref, shallowRef } from 'vue';
import { dateText, numberText, ManagementError, type ManagementClient, type Page } from '../api.js';
import { dateInput, isoInput, query } from '../formats.js';
import { userCountLabels as countLabels, type Allowance, type Capabilities, type User, type UserDetail } from '../server-types.js';
import { useDetailFocus } from '../useDetailFocus.js';
import { useRequest } from '../useRequest.js';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PaginationBar from '../components/PaginationBar.vue';
import RequestState from '../components/RequestState.vue';
import StatusBadge from '../components/StatusBadge.vue';
const props = defineProps<{ client: ManagementClient; capabilities: Capabilities }>();
const emit = defineEmits<{ sessionLost: [] }>();
const { busy, writing, error, notice, run, cancel } = useRequest(props.client, () => emit('sessionLost'));
const detailFocus = useDetailFocus(), quotaFocus = useDetailFocus();
const detailRegion = detailFocus.region, quotaRegion = quotaFocus.region;
const actionTrigger = shallowRef<HTMLElement | null>(null);
const result = shallowRef<Page<User>>(), detail = shallowRef<UserDetail>(), quotaUser = shallowRef<User>();
const search = ref(''), status = ref('all'), applied = reactive({ q: '', status: 'all' });
const create = reactive({ username: '', password: '' }), generated = ref(''), generatedFor = ref('');
const action = ref<'disable' | 'enable' | 'password' | 'delete'>(), target = shallowRef<User>(), resetPassword = ref('');
const quota = reactive({ mode: 'BYO' as Allowance['mode'], tokens: '', cents: '', expires: '' });
function can(key: keyof Capabilities) { return props.capabilities[key] === true; }
function clearDetail() { detail.value = undefined; quotaUser.value = undefined; generated.value = ''; generatedFor.value = ''; }
async function load(page = result.value?.page ?? 1) {
  result.value = undefined;
  await run(async (signal) => {
    const path = (p: number) => query('/users', { page: p, q: applied.q, ...(can('userDisable') ? { status: applied.status } : {}) });
    let rows = await props.client.request<Page<User>>(path(page), undefined, true, undefined, signal);
    if (!rows.items.length && page > 1) rows = await props.client.request<Page<User>>(path(Math.max(1, Math.ceil(rows.total / rows.pageSize))), undefined, true, undefined, signal);
    return rows;
  }, (rows) => { result.value = rows; });
}
async function filter(reset = false) { if (reset) { search.value = ''; status.value = 'all'; } applied.q = search.value.trim(); applied.status = status.value; clearDetail(); await load(1); }
async function createUser() {
  if (!can('users')) return;
  const password = create.password; create.password = ''; generated.value = '';
  const ok = await run(() => props.client.request<{ user: User; generatedPassword?: string }>('/users', { username: create.username.trim(), ...(password ? { password } : {}) }), (value) => { generated.value = value.generatedPassword ?? ''; generatedFor.value = value.user.username; create.username = ''; }, true);
  if (ok) { await load(1); notice.value = `用户 ${generatedFor.value} 已创建。`; }
}
async function openDetail(user: User, event?: Event) {
  detailFocus.capture(event);
  clearDetail();
  if (!can('userDetails')) return;
  const loaded = await run((signal) => props.client.request<UserDetail>(`/users/${encodeURIComponent(user.id)}`, undefined, true, undefined, signal), (value) => { detail.value = value; });
  if (loaded) await detailFocus.reveal();
}
async function openAction(user: User, operation: typeof action.value, event?: Event) {
  if (!operation || !can(operation === 'delete' ? 'userDelete' : operation === 'password' ? 'userPasswordReset' : 'userDisable')) return;
  actionTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  generated.value = ''; resetPassword.value = ''; error.value = '';
  if (operation === 'delete') {
    if (!can('userDetails')) return;
    const ok = await run(async (signal) => {
      const value = await props.client.request<UserDetail>(`/users/${encodeURIComponent(user.id)}`, undefined, true, undefined, signal);
      if (value.id !== user.id || value.username !== user.username || !value.counts || !Object.keys(value.counts).length || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0)) throw new ManagementError('INVALID_RESPONSE', '无法确认用户及关联数据，请刷新用户列表后重试。');
      return value;
    }, (value) => { detail.value = value; });
    if (!ok) return;
  }
  target.value = user; action.value = operation;
}
function closeAction() { if (writing.value) return; action.value = undefined; target.value = undefined; resetPassword.value = ''; error.value = ''; }
async function confirmAction() {
  const user = target.value, operation = action.value;
  if (!user || !operation || !can(operation === 'delete' ? 'userDelete' : operation === 'password' ? 'userPasswordReset' : 'userDisable')) return;
  const password = resetPassword.value; resetPassword.value = '';
  const ok = await run(async () => {
    const path = `/users/${encodeURIComponent(user.id)}`;
    if (operation === 'delete') return props.client.request<{ generatedPassword?: string }>(path, { confirmUsername: user.username }, true, 'DELETE');
    if (operation === 'password') return props.client.request<{ generatedPassword?: string }>(`${path}/password`, password ? { password } : {});
    return props.client.request<{ generatedPassword?: string }>(path, { disabled: operation === 'disable' }, true, 'PATCH');
  }, (value) => { action.value = undefined; target.value = undefined; detail.value = undefined; quotaUser.value = undefined; generated.value = value.generatedPassword ?? ''; generatedFor.value = user.username; }, true);
  if (ok) { await load(); notice.value = operation === 'delete' ? `用户 ${user.username} 已永久删除。` : operation === 'password' ? `${user.username} 的密码已重置，旧会话已失效。` : `${user.username} 已${operation === 'disable' ? '停用，旧会话已失效' : '启用，需重新登录'}。`; }
}
async function openQuota(user: User, event?: Event) {
  if (!can('aiAllowance')) return;
  quotaFocus.capture(event);
  clearDetail();
  const loaded = await run((signal) => props.client.request<Allowance>(`/users/${encodeURIComponent(user.id)}/ai`, undefined, true, undefined, signal), (value) => { quotaUser.value = { ...user, ai: value }; quota.mode = value.mode; quota.tokens = value.monthlyTokenLimit?.toString() ?? ''; quota.cents = value.monthlyCostLimitCents?.toString() ?? ''; quota.expires = dateInput(value.expiresAt); });
  if (loaded) await quotaFocus.reveal();
}
function closeDetail() { detail.value = undefined; void detailFocus.restore(); }
function closeQuota() { quotaUser.value = undefined; void quotaFocus.restore(); }
async function saveQuota() {
  const user = quotaUser.value;
  if (!user || !can('aiAllowance')) return;
  const ok = await run(() => props.client.request(`/users/${encodeURIComponent(user.id)}/ai`, { mode: quota.mode, monthlyTokenLimit: quota.tokens === '' ? null : Number(quota.tokens), monthlyCostLimitCents: quota.cents === '' ? null : Number(quota.cents), expiresAt: isoInput(quota.expires) }, true, 'PUT'), () => { quotaUser.value = undefined; }, true);
  if (ok) { await load(); notice.value = `${user.username} 的 AI 授权已保存。`; }
}
onMounted(() => load(1));
</script>
<template>
  <div class="panel-toolbar"><h3>用户管理</h3><button type="button" :disabled="busy" @click="load()">刷新</button></div>
  <form class="filter-bar filter-fields" @submit.prevent="filter()"><div class="field"><label for="user-search">用户名</label><input id="user-search" v-model="search" type="search" maxlength="32" autocomplete="off" :disabled="writing" /></div><div v-if="can('userDisable')" class="field"><label for="user-status">账号状态</label><select id="user-status" v-model="status" :disabled="writing"><option value="all">全部状态</option><option value="active">启用</option><option value="disabled">停用</option></select></div><button type="submit" :disabled="writing">搜索</button><button type="button" :disabled="writing" @click="filter(true)">重置</button></form>
  <RequestState :busy="busy" :writing="writing" :error="action ? '' : error" :notice="notice" @cancel="cancel" />
  <details class="surface"><summary>创建用户</summary><form @submit.prevent="createUser"><div class="form-grid"><div class="field"><label for="new-username">用户名</label><input id="new-username" v-model="create.username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\-]{3,32}" autocomplete="off" :disabled="busy" /><p class="field-hint">3–32 位英文字母、数字、点、下划线或短横线。</p></div><div class="field"><label for="new-user-password">初始密码（选填）</label><input id="new-user-password" v-model="create.password" type="password" minlength="8" maxlength="256" autocomplete="new-password" :disabled="busy" /><p class="field-hint">8–256 个字符；留空自动生成，仅显示一次。</p></div></div><button type="submit" class="primary" :disabled="busy || !can('users')">创建用户</button></form></details>
  <div v-if="generated" class="message success" role="status"><p>{{ generatedFor }} 的新密码，请保存：</p><code class="generated-secret">{{ generated }}</code><button type="button" @click="generated = ''">已保存，隐藏密码</button></div>
  <section v-if="detail" ref="detailRegion" class="surface detail-region" tabindex="-1" aria-labelledby="user-detail-heading"><div class="panel-toolbar"><h3 id="user-detail-heading">{{ detail.username }} · 用户详情</h3><button type="button" :disabled="writing" @click="closeDetail">关闭详情</button></div><dl class="detail-list"><dt>账号状态</dt><dd><StatusBadge :value="detail.status" /></dd><dt>创建时间</dt><dd>{{ dateText(detail.createdAt) }}</dd><dt>最近同步写入</dt><dd>{{ dateText(detail.lastSyncWrite) }}</dd><dt>档案版本</dt><dd>{{ numberText(detail.archiveVersion) }}</dd></dl><div v-if="detail.counts" class="count-grid"><div v-for="(value, key) in detail.counts" :key="key"><span>{{ countLabels[key] ?? key }}</span><strong>{{ numberText(value) }}</strong></div></div></section>
  <form v-if="quotaUser" ref="quotaRegion" class="surface detail-region" tabindex="-1" aria-labelledby="quota-heading" @submit.prevent="saveQuota"><div class="panel-toolbar"><h3 id="quota-heading">{{ quotaUser.username }} · AI 授权</h3><button type="button" :disabled="writing" @click="closeQuota">关闭</button></div><p class="muted">本期已用 {{ numberText(quotaUser.ai?.usedTokens) }} Token / {{ numberText(quotaUser.ai?.usedCostCents) }} 美分 · 周期开始 {{ dateText(quotaUser.ai?.periodStart) }}</p><div class="form-grid"><div class="field"><label for="quota-mode">授权模式</label><select id="quota-mode" v-model="quota.mode" :disabled="busy"><option value="BYO">仅用户自己的密钥</option><option value="POOL">共享池</option><option value="BOTH">自己的密钥和共享池</option></select></div><div class="field"><label for="quota-tokens">每月 Token 上限</label><input id="quota-tokens" v-model="quota.tokens" type="number" min="0" max="2147483647" step="1" placeholder="留空不限" :disabled="busy" /><p class="field-hint">留空不限；0 禁用共享池。</p></div><div class="field"><label for="quota-cents">每月费用上限（美分）</label><input id="quota-cents" v-model="quota.cents" type="number" min="0" max="2147483647" step="1" placeholder="留空不限" :disabled="busy" /><p class="field-hint">留空不限；0 禁用共享池。保存保留已用额度。</p></div><div class="field"><label for="quota-expires">到期时间（本地时间，选填）</label><input id="quota-expires" v-model="quota.expires" type="datetime-local" :disabled="busy" /></div></div><button type="submit" class="primary" :disabled="busy || !can('aiAllowance')">保存授权</button></form>
  <div v-if="result" class="table-wrap" tabindex="0" role="region" aria-label="用户列表，可横向滚动"><table><caption class="sr-only">用户列表</caption><thead><tr><th scope="col">用户</th><th scope="col">状态</th><th scope="col">创建 / 最近同步</th><th scope="col">AI 授权 / 本期使用</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="user in result.items" :key="user.id"><td><button v-if="can('userDetails')" type="button" class="link-button" :disabled="busy" @click="openDetail(user, $event)">{{ user.username }}</button><strong v-else>{{ user.username }}</strong><small class="record-id mono">{{ user.id }}</small></td><td><StatusBadge :value="user.status" /></td><td class="date-cell">{{ dateText(user.createdAt) }}<small class="record-id">同步 {{ dateText(user.lastSyncWrite) }}</small></td><td>{{ user.ai?.mode ?? 'BYO' }}<small v-if="user.ai" class="record-id">{{ numberText(user.ai.usedTokens) }} Token · {{ numberText(user.ai.usedCostCents) }} 美分</small></td><td><div class="row-actions"><button v-if="can('aiAllowance')" type="button" :disabled="busy" :aria-label="`管理 ${user.username} 的 AI 授权`" @click="openQuota(user, $event)">AI 授权</button><button v-if="can('userDisable')" type="button" :disabled="busy" @click="openAction(user, user.status === 'disabled' ? 'enable' : 'disable', $event)">{{ user.status === 'disabled' ? '启用' : '停用' }}</button><button v-if="can('userPasswordReset')" type="button" :disabled="busy" @click="openAction(user, 'password', $event)">重置密码</button><button v-if="can('userDelete') && can('userDetails')" type="button" class="danger" :disabled="busy" @click="openAction(user, 'delete', $event)">删除</button></div></td></tr><tr v-if="!result.items.length"><td colspan="5" class="empty-cell">暂无符合条件的用户。</td></tr></tbody></table></div>
  <PaginationBar v-if="result" :result="result" :busy="busy" @change="clearDetail(); load($event)" />
  <ConfirmDialog v-if="action && target" :return-focus="actionTrigger" :title="`${action === 'delete' ? '永久删除' : action === 'password' ? '重置密码：' : action === 'disable' ? '停用' : '启用'} ${target.username}`" :description="action === 'delete' ? '永久删除此用户及关联的学习档案、作答记录、排行榜资料、AI 密钥、授权、用量、同步记录和反馈。旧会话失效，邀请码使用记录保留匿名关联，管理审计保留。此操作无法撤销。' : action === 'password' ? '新密码保存后，旧密码和所有旧登录会话立即失效。' : action === 'disable' ? '停用后，该用户无法登录、同步或使用 AI；已有登录会话失效。保留用户数据。' : '恢复账号访问。用户必须重新登录，旧会话不会恢复。'" :match="action === 'delete' ? target.username : undefined" :confirm-label="action === 'delete' ? '永久删除用户' : action === 'password' ? '重置密码' : action === 'disable' ? '确认停用' : '确认启用'" :danger="action !== 'enable'" :busy="writing" :error="error" @close="closeAction" @confirm="confirmAction"><div v-if="action === 'delete' && detail?.counts" class="count-grid"><div v-for="(value, key) in detail.counts" :key="key"><span>{{ countLabels[key] ?? key }}</span><strong>{{ numberText(value) }}</strong></div></div><div v-if="action === 'password'" class="field"><label for="reset-user-password">新密码（选填）</label><input id="reset-user-password" v-model="resetPassword" type="password" minlength="8" maxlength="256" autocomplete="new-password" :disabled="writing" /><p class="field-hint">8–256 个字符；留空自动生成，仅显示一次。</p></div></ConfirmDialog>
</template>
