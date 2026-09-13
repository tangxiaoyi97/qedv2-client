<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
const props = defineProps<{ title: string; description: string; confirmLabel?: string; match?: string; busy?: boolean; error?: string; danger?: boolean; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ confirm: []; close: [] }>();
const dialog = ref<HTMLDialogElement>(), entered = ref(''), id = useId();
const matches = computed(() => props.match === undefined || entered.value === props.match);
const previousFocus = props.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
function close() { if (!props.busy) emit('close'); }
function trap(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (event.key !== 'Tab') return;
  const items = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
  const first = items[0], last = items.at(-1);
  if (!first) { event.preventDefault(); dialog.value?.focus(); }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
onMounted(async () => { await nextTick(); if (typeof dialog.value?.showModal === 'function') dialog.value.showModal(); else dialog.value?.setAttribute('open', ''); dialog.value?.querySelector<HTMLElement>('[data-initial-focus]')?.focus(); });
onBeforeUnmount(() => { dialog.value?.close?.(); if (previousFocus?.isConnected) previousFocus.focus(); void nextTick(() => { if (!previousFocus?.isConnected) document.querySelector<HTMLElement>('.section-nav [aria-pressed="true"], #node-workspace')?.focus(); }); entered.value = ''; });
</script>
<template><Teleport to="body"><dialog ref="dialog" class="admin-dialog" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`" tabindex="-1" @cancel.prevent="close" @keydown="trap"><form @submit.prevent="matches && !busy && $emit('confirm')"><div class="panel-toolbar"><h3 :id="`${id}-title`">{{ title }}</h3><button type="button" data-initial-focus :disabled="busy" @click="close">取消</button></div><p :id="`${id}-description`" class="dialog-description">{{ description }}</p><slot /><div v-if="match !== undefined" class="field"><label :for="`${id}-match`">输入「{{ match }}」以确认</label><input :id="`${id}-match`" v-model="entered" autocomplete="off" spellcheck="false" :disabled="busy" required /></div><p v-if="error" class="message error" role="alert">{{ error }}</p><div class="actions dialog-actions"><button type="submit" :class="danger ? 'danger' : 'primary'" :disabled="busy || !matches">{{ busy ? '正在提交…' : confirmLabel ?? '确认' }}</button></div></form></dialog></Teleport></template>
