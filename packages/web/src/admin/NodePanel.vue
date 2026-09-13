<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { dateText, errorText, ManagementClient, ManagementError, normalizeNodeAddress, type Grant, type NodeKind, type NodeStatus } from './api.js';
import ServerPanel from './ServerPanel.vue';
import CorePanel from './CorePanel.vue';

const props = defineProps<{ kind: NodeKind }>();
const emit = defineEmits<{ status: [text: string] }>();
const label = computed(() => props.kind === 'server' ? 'Server' : 'Core');
const storageKey = `qed2.admin.${props.kind}.origin`;
const defaultAddress = import.meta.env.DEV
  ? `http://127.0.0.1:${props.kind === 'server' ? 8081 : 8788}`
  : `https://${props.kind === 'server' ? 'qedsync' : 'qedcore'}.barcarolle.studio`;
function savedAddress(): string {
  try { return normalizeNodeAddress(localStorage.getItem(storageKey) ?? defaultAddress); } catch { return defaultAddress; }
}
const address = ref(savedAddress());
const client = shallowRef<ManagementClient>();
const nodeStatus = ref<NodeStatus>();
const grant = ref<Grant>();
const busy = ref(false);
const error = ref('');
const notice = ref('');
const secret = ref('');
const password = ref('');
const repeatPassword = ref('');
const currentPassword = ref('');
const passwordForm = ref(false);
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let currentGeneration = 0;

function clearSecrets(): void { secret.value = ''; password.value = ''; repeatPassword.value = ''; currentPassword.value = ''; }
function clearSession(): void {
  clearTimeout(expiryTimer);
  grant.value = undefined;
  client.value?.forget();
  passwordForm.value = false;
  clearSecrets();
  emit('status', nodeStatus.value ? '待登录' : '未连接');
}
// Editing the destination invalidates the connection immediately. A password
// may never go to a previously connected origin hidden behind newly typed text.
watch(address, (value) => {
  if (client.value && value.trim() !== client.value.address) {
    clearSession(); nodeStatus.value = undefined; client.value = undefined;
    notice.value = ''; error.value = ''; emit('status', '未连接');
  }
}, { flush: 'sync' });
function acceptGrant(value: Grant): void {
  grant.value = value;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    clearSession();
    notice.value = '管理会话已到期，请重新登录。';
  }, Math.max(0, new Date(value.expiresAt).getTime() - Date.now()));
  emit('status', value.requiresPasswordSetup ? '待设密码' : '已登录');
}
async function run(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await work(); }
  catch (caught) { error.value = errorText(caught); if (client.value && !client.value.session && grant.value) clearSession(); }
  finally { busy.value = false; }
}
async function connect(): Promise<void> {
  await run(async () => {
    currentGeneration += 1;
    clearSession(); nodeStatus.value = undefined;
    client.value = new ManagementClient(address.value);
    emit('status', '连接中');
    try {
      const status = await client.value.status();
      if (status.service !== `qed2-${props.kind}` || typeof status.initialized !== 'boolean') {
        throw new ManagementError('WRONG_NODE', `该地址不是可识别的 ${label.value} 管理节点。`);
      }
      if (status.apiVersion !== 1) throw new ManagementError('INCOMPATIBLE_API', '节点管理协议版本不兼容。请升级节点或管理页面后再登录。');
      nodeStatus.value = status;
      address.value = client.value.address;
      try { localStorage.setItem(storageKey, address.value); } catch { /* optional, address only */ }
      emit('status', '待登录');
      notice.value = '连接成功。';
    } catch (caught) { emit('status', '连接失败'); throw caught; }
  });
}
async function login(): Promise<void> {
  await run(async () => {
    try { if (client.value) acceptGrant(await client.value.login(secret.value)); }
    finally { secret.value = ''; }
  });
}
async function savePassword(): Promise<void> {
  await run(async () => {
    try {
      if (password.value !== repeatPassword.value) { error.value = '两次输入的密码不一致。'; return; }
      if (!client.value) return;
      const result = grant.value?.requiresPasswordSetup
        ? await client.value.setup(password.value)
        : await client.value.changePassword(currentPassword.value, password.value);
      acceptGrant(result);
      if (nodeStatus.value) nodeStatus.value.initialized = true;
      passwordForm.value = false;
      notice.value = '密码已保存，旧凭据和会话已失效。';
    } finally { clearSecrets(); }
  });
}
async function logout(): Promise<void> {
  await run(async () => {
    try { await client.value?.logout(); }
    finally { clearSession(); notice.value = '已退出。'; }
  });
}
function sessionLost(): void { clearSession(); notice.value = '节点会话已失效，请重新登录。'; }
function restartAccepted(): void { clearSession(); notice.value = '重启请求已接受。服务恢复后请重新登录。'; }
onBeforeUnmount(() => { currentGeneration += 1; clearTimeout(expiryTimer); clearSession(); });
</script>

<template>
  <section :aria-labelledby="`${kind}-title`" class="node-panel">
    <div class="workspace-heading"><h2 :id="`${kind}-title`">{{ label }}</h2>
      <div v-if="grant && !grant.requiresPasswordSetup" class="actions">
        <button type="button" :disabled="busy" :aria-expanded="passwordForm" @click="passwordForm = !passwordForm; clearSecrets()">修改密码</button>
        <button type="button" :disabled="busy" @click="logout">退出 {{ label }}</button>
      </div>
    </div>
    <div v-if="!grant" class="connection-layout" :class="{ 'connection-layout-single': !nodeStatus }">
      <form class="surface connection-form" @submit.prevent="connect">
        <h3>连接节点</h3>
        <label :for="`${kind}-address`">节点地址</label>
        <input :id="`${kind}-address`" v-model="address" type="url" required autocomplete="url" spellcheck="false" :disabled="busy" :placeholder="defaultAddress" />
        <p class="field-hint">使用 HTTPS，或本机 HTTP 管理端口。</p>
        <button type="submit" :disabled="busy" class="primary">{{ busy && !nodeStatus ? '正在连接…' : nodeStatus ? '重新连接' : '连接节点' }}</button>
      </form>
      <form v-if="nodeStatus" class="surface connection-form" @submit.prevent="login">
        <h3>{{ nodeStatus.initialized ? '登录' : '首次登录' }}</h3>
        <p v-if="!nodeStatus.initialized" class="muted">使用节点 bootstrap.key 中的初始密钥，登录后设置管理密码。</p>
        <p class="field-hint mono">{{ client?.address }}</p>
        <label :for="`${kind}-secret`">{{ nodeStatus.initialized ? '管理密码' : '初始管理密钥' }}</label>
        <input :id="`${kind}-secret`" v-model="secret" type="password" autocomplete="current-password" required maxlength="512" :disabled="busy" />
        <button type="submit" :disabled="busy" class="primary">{{ busy ? '正在验证…' : '登录' }}</button>
      </form>
    </div>
    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message success" role="status">{{ notice }}</p>
    <form v-if="grant && (grant.requiresPasswordSetup || passwordForm)" class="surface password-form" @submit.prevent="savePassword">
      <h3>{{ grant.requiresPasswordSetup ? '设置管理密码' : '更改管理密码' }}</h3>
      <p class="muted">至少 12 个字符，最多 256 个 UTF-8 字节。</p>
      <div v-if="!grant.requiresPasswordSetup" class="field"><label :for="`${kind}-current-password`">当前密码</label><input :id="`${kind}-current-password`" v-model="currentPassword" type="password" autocomplete="current-password" required :disabled="busy" /></div>
      <div class="form-grid"><div class="field"><label :for="`${kind}-new-password`">新密码</label><input :id="`${kind}-new-password`" v-model="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256" :disabled="busy" /></div>
        <div class="field"><label :for="`${kind}-repeat-password`">再次输入新密码</label><input :id="`${kind}-repeat-password`" v-model="repeatPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="256" :disabled="busy" /></div></div>
      <div class="actions"><button type="submit" class="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存管理密码' }}</button><button v-if="grant.requiresPasswordSetup" type="button" :disabled="busy" @click="logout">取消设置并退出</button><button v-else type="button" :disabled="busy" @click="passwordForm = false; clearSecrets()">取消</button></div>
    </form>
    <template v-if="grant && !grant.requiresPasswordSetup && client">
      <div class="session-strip"><span class="status-pill">已登录</span><span class="mono">{{ client.address }}</span><span>会话到期：{{ dateText(grant.expiresAt) }}</span></div>
      <ServerPanel v-if="kind === 'server'" :key="currentGeneration" :client="client" @session-lost="sessionLost" @restart="restartAccepted" />
      <CorePanel v-else :key="currentGeneration" :client="client" @session-lost="sessionLost" @restart="restartAccepted" />
    </template>
  </section>
</template>
