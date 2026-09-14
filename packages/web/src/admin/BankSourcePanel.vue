<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ManagementError, type ManagementClient } from './api.js';
import { assertBankSourceState, isBankSource, isCommit, sameBankSource, type BankSource, type BankSourceSaved, type BankSourceState } from './bank-source.js';
import { useRequest } from './useRequest.js';
import ConfirmDialog from './components/ConfirmDialog.vue';

const props = defineProps<{ client: ManagementClient; locked?: boolean; generation?: number }>();
const emit = defineEmits<{ sessionLost: []; changed: []; busy: [value: boolean] }>();
const { busy, writing, error, notice, run } = useRequest(props.client, () => emit('sessionLost'));
const state = ref<BankSourceState>(), editing = ref(false), repository = ref(''), branch = ref(''), fieldError = ref('');
const sourceRegion = ref<HTMLElement>(), repositoryField = ref<HTMLInputElement>(), editTrigger = ref<HTMLButtonElement>();
const confirmation = ref<{ reset: boolean; source: BankSource; revision: string }>();
const blocked = computed(() => busy.value || props.locked || !!state.value?.pending);
const dirty = computed(() => !state.value || !sameBankSource(state.value.source, { repository: repository.value.trim(), ref: branch.value.trim() }));
watch(writing, (value) => emit('busy', value), { immediate: true, flush: 'sync' });
watch(() => props.generation, () => { if (!writing.value) void refresh(); });
watch(() => props.locked, (value) => { if (value && !writing.value) confirmation.value = undefined; });
function apply(value: BankSourceState) { assertBankSourceState(value); state.value = value; }
async function refresh(manual = false) {
  if (writing.value || manual && props.locked) return;
  state.value = undefined; confirmation.value = undefined; editing.value = false; fieldError.value = '';
  const ok = await run((signal) => props.client.request<BankSourceState>('/core/bank-source', undefined, true, undefined, signal), apply);
  if (ok && manual) emit('changed');
}
async function edit() {
  if (!state.value || blocked.value) return;
  repository.value = state.value.source.repository; branch.value = state.value.source.ref;
  fieldError.value = ''; error.value = ''; notice.value = ''; editing.value = true;
  await nextTick(); repositoryField.value?.focus({ preventScroll: true });
}
async function cancelEdit() { editing.value = false; fieldError.value = ''; await nextTick(); editTrigger.value?.focus({ preventScroll: true }); }
function prepare(reset = false) {
  if (!state.value || blocked.value || (!reset && !dirty.value)) return;
  const source = reset ? { ...state.value.defaultSource } : { repository: repository.value.trim(), ref: branch.value.trim() };
  if (!isBankSource(source)) { fieldError.value = '请输入公开 GitHub HTTPS 仓库地址和有效分支名。'; return; }
  fieldError.value = ''; error.value = ''; confirmation.value = { reset, source, revision: state.value.source.revision };
}
async function save() {
  const approved = confirmation.value;
  if (!approved || blocked.value || approved.revision !== state.value?.source.revision) return;
  const body = { ...(approved.reset ? { reset: true } : approved.source), expectedRevision: approved.revision, confirmation: 'change-bank-source' };
  const ok = await run(() => props.client.request<BankSourceSaved>('/core/bank-source', body), (value) => {
    assertBankSourceState(value);
    if (!isCommit(value.latestCommit) || typeof value.changed !== 'boolean' || !['confirmed', 'uncertain'].includes(value.durability)) throw new ManagementError('INVALID_RESPONSE', '保存结果无法确认，请先刷新题库来源。');
    apply(value); confirmation.value = undefined; editing.value = false;
    if (value.durability === 'uncertain') error.value = '来源已选中，但持久保存尚未确认。请检查节点存储后再更新题库。';
    else notice.value = value.changed ? '题库来源已保存。' : '题库来源未变化。';
  }, true);
  if (ok) { emit('changed'); await nextTick(); sourceRegion.value?.focus({ preventScroll: true }); }
}
onMounted(() => refresh());
</script>

<template>
  <section ref="sourceRegion" class="surface" tabindex="-1" aria-labelledby="bank-source-title">
    <div class="panel-toolbar"><h3 id="bank-source-title">题库来源</h3><button type="button" :disabled="busy || locked" @click="refresh(true)">{{ busy && !writing ? '正在获取…' : '刷新来源' }}</button></div>
    <p v-if="error && !confirmation" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message success" role="status">{{ notice }}</p>
    <p v-if="!state && busy" role="status">正在获取题库来源…</p>
    <template v-if="state">
      <dl class="detail-list"><dt>获取仓库</dt><dd class="mono">{{ state.source.repository }}</dd><dt>分支</dt><dd class="mono">{{ state.source.ref }}</dd><dt>配置</dt><dd>{{ state.source.origin === 'deployment' ? '部署默认' : '自定义' }}</dd></dl>
      <p v-if="state.pending" class="field-hint" role="status">有待重启题库，请先重启 Core，再更改来源。</p>
      <form v-if="editing" @submit.prevent="prepare()">
        <div class="form-grid"><div class="field form-wide"><label for="bank-source-repository">GitHub 仓库地址</label><input ref="repositoryField" id="bank-source-repository" v-model="repository" type="url" maxlength="256" autocomplete="off" spellcheck="false" :disabled="blocked" aria-describedby="bank-source-hint" required /></div><div class="field"><label for="bank-source-ref">分支</label><input id="bank-source-ref" v-model="branch" maxlength="128" autocomplete="off" spellcheck="false" :disabled="blocked" required /></div></div>
        <p id="bank-source-hint" class="field-hint">仅支持公开 GitHub 仓库，题库格式须与当前 Core 兼容。</p>
        <p v-if="fieldError" class="message error" role="alert">{{ fieldError }}</p>
        <div class="actions"><button type="submit" class="primary" :disabled="blocked || !dirty">保存来源</button><button type="button" :disabled="writing" @click="cancelEdit">取消编辑</button></div>
      </form>
      <div v-else class="actions"><button ref="editTrigger" type="button" :disabled="blocked" @click="edit">更改来源</button><button v-if="state.source.origin === 'override'" type="button" :disabled="blocked" @click="prepare(true)">恢复默认</button></div>
    </template>
    <ConfirmDialog v-if="confirmation" :title="confirmation.reset ? '恢复默认题库来源' : '更改题库来源'" description="保存后用于下一次下载。当前题库保持运行，下载校验并重启后才切换。" confirm-label="确认保存来源" danger :busy="writing" :error="error" @confirm="save" @close="confirmation = undefined; error = ''">
      <dl class="detail-list"><dt>仓库</dt><dd class="mono">{{ confirmation.source.repository }}</dd><dt>分支</dt><dd class="mono">{{ confirmation.source.ref }}</dd></dl>
    </ConfirmDialog>
  </section>
</template>
