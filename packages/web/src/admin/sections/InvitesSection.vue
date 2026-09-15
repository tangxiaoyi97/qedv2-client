<script setup lang="ts">
import { onMounted, reactive, ref, shallowRef } from 'vue';
import { dateText, numberText, type ManagementClient, type Page } from '../api.js';
import { dateInput, isoInput, query } from '../formats.js';
import type { Capabilities, Invite } from '../server-types.js';
import { useDetailFocus } from '../useDetailFocus.js';
import { useRequest } from '../useRequest.js';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PaginationBar from '../components/PaginationBar.vue';
import RequestState from '../components/RequestState.vue';
import StatusBadge from '../components/StatusBadge.vue';
const props = defineProps<{ client: ManagementClient; capabilities: Capabilities }>();
const emit = defineEmits<{ sessionLost: [] }>();
const { busy, writing, error, notice, run, cancel } = useRequest(props.client, () => emit('sessionLost'));
const detailFocus = useDetailFocus(), detailRegion = detailFocus.region;
const actionTrigger = shallowRef<HTMLElement | null>(null);
const result = shallowRef<Page<Invite>>(), detail = shallowRef<Invite>(), target = shallowRef<Invite>();
const filters = reactive({ q: '', kind: 'all', status: 'all' }), applied = reactive({ q: '', kind: 'all', status: 'all' });
const create = reactive({ kind: 'once', code: '', expires: '' });
const generated = ref(''), expires = ref(''), action = ref<'revoke' | 'restore' | 'expiry' | 'delete'>();
function can(key: keyof Capabilities) { return props.capabilities[key] === true; }
async function load(page = result.value?.page ?? 1) {
  result.value = undefined;
  await run(async (signal) => {
    const path = (p: number) => query('/invites', { page: p, ...(can('inviteEdit') ? applied : {}) });
    let rows = await props.client.request<Page<Invite>>(path(page), undefined, true, undefined, signal);
    if (!rows.items.length && page > 1) rows = await props.client.request<Page<Invite>>(path(Math.max(1, Math.ceil(rows.total / rows.pageSize))), undefined, true, undefined, signal);
    return rows;
  }, (rows) => { result.value = rows; });
}
async function filter(reset = false) { if (reset) Object.assign(filters, { q: '', kind: 'all', status: 'all' }); Object.assign(applied, filters, { q: filters.q.trim() }); detail.value = undefined; generated.value = ''; await load(1); }
async function createInvite() {
  if (!can('invites')) return;
  generated.value = '';
  const ok = await run(() => props.client.request<Invite>('/invites', { kind: create.kind, ...(create.kind === 'permanent' && create.code.trim() ? { code: create.code.trim() } : {}), expiresAt: isoInput(create.expires) }), (value) => { generated.value = value.code; create.code = ''; create.expires = ''; }, true);
  if (ok) { await load(1); notice.value = '邀请码已创建。'; }
}
async function openDetail(invite: Invite, event?: Event) {
  if (!can('inviteUsage')) return;
  detailFocus.capture(event);
  detail.value = undefined; generated.value = '';
  const loaded = await run((signal) => props.client.request<Invite>(`/invites/${encodeURIComponent(invite.id)}`, undefined, true, undefined, signal), (value) => { detail.value = value; });
  if (loaded) await detailFocus.reveal();
}
function closeDetail() { detail.value = undefined; void detailFocus.restore(); }
function openAction(invite: Invite, value: typeof action.value, event?: Event) { if (!can(value === 'delete' ? 'inviteDelete' : 'inviteEdit')) return; actionTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null; target.value = invite; action.value = value; expires.value = dateInput(invite.expiresAt); error.value = ''; generated.value = ''; }
function close() { if (writing.value) return; action.value = undefined; target.value = undefined; error.value = ''; }
async function confirm() {
  const invite = target.value, operation = action.value;
  if (!invite || !operation || !can(operation === 'delete' ? 'inviteDelete' : 'inviteEdit')) return;
  const ok = await run(() => props.client.request(`/invites/${encodeURIComponent(invite.id)}`, operation === 'delete' ? { confirmCode: invite.code } : operation === 'expiry' ? { expiresAt: isoInput(expires.value) } : { disabled: operation === 'revoke' }, true, operation === 'delete' ? 'DELETE' : 'PATCH'), () => { action.value = undefined; target.value = undefined; detail.value = undefined; }, true);
  if (ok) { await load(); notice.value = operation === 'delete' ? '邀请码已永久删除。' : operation === 'expiry' ? '到期时间已保存。' : operation === 'revoke' ? '邀请码已撤销。' : '邀请码已恢复；到期时间和一次性使用限制仍然生效。'; }
}
function useCount(invite: Invite) { return invite.useCount === undefined ? '—' : `${invite.useCountComplete === false ? '至少 ' : ''}${numberText(invite.useCount)}`; }
onMounted(() => load(1));
</script>
<template>
  <div class="panel-toolbar"><h3>邀请码管理</h3><button type="button" :disabled="busy" @click="load()">刷新</button></div>
  <form v-if="can('inviteEdit')" class="filter-bar filter-fields" @submit.prevent="filter()"><div class="field"><label for="invite-search">邀请码</label><input id="invite-search" v-model="filters.q" type="search" maxlength="64" autocomplete="off" :disabled="writing" /></div><div class="field"><label for="invite-kind-filter">类型</label><select id="invite-kind-filter" v-model="filters.kind" :disabled="writing"><option value="all">全部类型</option><option value="once">一次性</option><option value="permanent">长期</option></select></div><div class="field"><label for="invite-status-filter">状态</label><select id="invite-status-filter" v-model="filters.status" :disabled="writing"><option value="all">全部状态</option><option value="available">可用</option><option value="disabled">已撤销</option><option value="expired">已过期</option><option value="used">已使用</option></select></div><button type="submit" :disabled="writing">筛选</button><button type="button" :disabled="writing" @click="filter(true)">重置</button></form>
  <RequestState :busy="busy" :writing="writing" :error="action ? '' : error" :notice="notice" @cancel="cancel" />
  <details class="surface"><summary>创建邀请码</summary><form @submit.prevent="createInvite"><div class="form-grid"><div class="field"><label for="invite-kind">类型</label><select id="invite-kind" v-model="create.kind" :disabled="busy"><option value="once">一次性邀请码</option><option value="permanent">长期邀请码（可重复使用）</option></select></div><div v-if="create.kind === 'permanent'" class="field"><label for="invite-code">自定义邀请码{{ can('inviteEdit') ? '（选填）' : '' }}</label><input id="invite-code" v-model="create.code" :required="!can('inviteEdit')" minlength="4" maxlength="64" autocomplete="off" :disabled="busy" /><p class="field-hint">4–64 位英文字母、数字、下划线或短横线{{ can('inviteEdit') ? '；留空自动生成。' : '。' }}</p></div><div class="field"><label for="invite-expires">到期时间（本地时间，选填）</label><input id="invite-expires" v-model="create.expires" type="datetime-local" :disabled="busy" /><p class="field-hint">留空不过期；设置时必须晚于当前时间。</p></div></div><button type="submit" class="primary" :disabled="busy || !can('invites')">创建邀请码</button></form></details>
  <div v-if="generated" class="message success" role="status"><p>已创建邀请码：</p><code class="generated-secret">{{ generated }}</code><button type="button" @click="generated = ''">隐藏</button></div>
  <section v-if="detail" ref="detailRegion" class="surface detail-region" tabindex="-1" aria-labelledby="invite-detail-heading"><div class="panel-toolbar"><h3 id="invite-detail-heading">兑换记录 · <span class="mono">{{ detail.code }}</span></h3><button type="button" @click="closeDetail">关闭详情</button></div><p class="muted">使用次数：{{ useCount(detail) }}</p><p v-if="detail.useCountComplete === false" class="field-hint">旧邀请码的早期兑换次数不完整，此处显示已记录的最低次数。</p><div class="table-wrap" tabindex="0" role="region" aria-label="最近兑换记录"><table><caption>最近 10 条兑换记录</caption><thead><tr><th scope="col">兑换时间</th><th scope="col">用户</th></tr></thead><tbody><tr v-for="use in detail.recentUses" :key="use.id"><td>{{ dateText(use.usedAt) }}</td><td>{{ use.user?.username ?? '用户已删除' }}</td></tr><tr v-if="!detail.recentUses?.length"><td colspan="2" class="empty-cell">暂无已记录的兑换。</td></tr></tbody></table></div></section>
  <div v-if="result" class="table-wrap" tabindex="0" role="region" aria-label="邀请码列表，可横向滚动"><table><caption class="sr-only">邀请码列表</caption><thead><tr><th scope="col">邀请码 / 类型</th><th scope="col">状态</th><th scope="col">使用次数</th><th scope="col">创建 / 到期时间</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="invite in result.items" :key="invite.id"><td><code class="generated-secret">{{ invite.code }}</code><small class="record-id">{{ invite.kind === 'once' ? '一次性' : '长期 · 可重复使用' }}</small></td><td><StatusBadge :value="invite.status === 'disabled' ? 'revoked' : invite.status === 'active' ? 'available' : invite.status" /></td><td>{{ useCount(invite) }}<button v-if="can('inviteUsage')" type="button" class="link-button record-link" :disabled="busy" @click="openDetail(invite, $event)">兑换记录</button></td><td class="date-cell">{{ dateText(invite.createdAt) }}<small class="record-id">到期 {{ invite.expiresAt ? dateText(invite.expiresAt) : '不限' }}</small></td><td><div class="row-actions"><button v-if="can('inviteEdit')" type="button" :disabled="busy" @click="openAction(invite, invite.disabledAt || invite.status === 'disabled' ? 'restore' : 'revoke', $event)">{{ invite.disabledAt || invite.status === 'disabled' ? '恢复' : '撤销' }}</button><button v-if="can('inviteEdit')" type="button" :disabled="busy" @click="openAction(invite, 'expiry', $event)">修改到期</button><button v-if="can('inviteDelete')" type="button" class="danger" :disabled="busy" @click="openAction(invite, 'delete', $event)">删除</button><span v-if="!can('inviteEdit') && !can('inviteDelete')">—</span></div></td></tr><tr v-if="!result.items.length"><td colspan="5" class="empty-cell">暂无符合条件的邀请码。</td></tr></tbody></table></div>
  <PaginationBar v-if="result" :result="result" :busy="busy" @change="detail = undefined; generated = ''; load($event)" />
  <ConfirmDialog v-if="action && target" :return-focus="actionTrigger" :title="action === 'delete' ? '永久删除邀请码' : action === 'expiry' ? '修改到期时间' : action === 'restore' ? '恢复邀请码' : '撤销邀请码'" :description="action === 'delete' ? '永久删除此邀请码及其兑换记录，之后无法用该码注册。已注册用户不受影响。此操作无法撤销。' : action === 'expiry' ? '修改后立即生效；留空表示不过期。已使用的一次性邀请码不会因此重新可用。' : action === 'restore' ? '恢复后允许兑换，到期时间和一次性使用限制仍然生效。' : '撤销后立即停止兑换。已注册用户不受影响，可稍后恢复。'" :match="action === 'delete' ? target.code : undefined" :confirm-label="action === 'delete' ? '永久删除邀请码' : action === 'expiry' ? '保存到期时间' : action === 'restore' ? '确认恢复' : '确认撤销'" :danger="action === 'delete' || action === 'revoke'" :busy="writing" :error="error" @close="close" @confirm="confirm"><p class="dialog-target mono">{{ target.code }}</p><div v-if="action === 'expiry'" class="field"><label for="edit-invite-expiry">到期时间（本地时间，选填）</label><input id="edit-invite-expiry" v-model="expires" type="datetime-local" :disabled="writing" /></div></ConfirmDialog>
</template>
