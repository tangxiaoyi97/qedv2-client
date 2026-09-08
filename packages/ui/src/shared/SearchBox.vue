<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * Debounced global search input (search upgrade doc §1). Emits `search` only
 * after the debounce window; clearing emits an empty string immediately so
 * the host can switch straight back to the normal browse view.
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import { LoaderCircle, Search, X } from 'lucide-vue-next';
import QIconButton from './QIconButton.vue';

const { t } = useI18n();

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  /** Debounce in ms (doc: 250–350). */
  debounceMs?: number;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** Fired debounced (or immediately on clear). */
  search: [query: string];
}>();

const inner = ref(props.modelValue);
const inputElement = ref<HTMLInputElement | null>(null);
let composing = false;
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.modelValue,
  (v) => {
    if (v !== inner.value) inner.value = v;
  },
);

function onInput(ev: Event): void {
  const value = (ev.target as HTMLInputElement).value;
  inner.value = value;
  emit('update:modelValue', value);
  if (timer !== undefined) clearTimeout(timer);
  if (composing || (ev as InputEvent).isComposing) return;
  if (value.trim() === '') {
    emit('search', '');
    return;
  }
  timer = setTimeout(() => emit('search', value.trim()), props.debounceMs ?? 300);
}

function onCompositionStart(): void {
  composing = true;
  if (timer !== undefined) clearTimeout(timer);
}
function onCompositionEnd(event: Event): void {
  composing = false;
  onInput(event);
}
function searchNow(event: KeyboardEvent): void {
  // Candidate confirmation belongs to the input method, including Safari's
  // keyCode 229 event after compositionend. Do not cancel its native action.
  if (composing || event.isComposing || event.keyCode === 229) {
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  if (timer !== undefined) clearTimeout(timer);
  emit('search', inner.value.trim());
}

function clear(): void {
  if (timer !== undefined) clearTimeout(timer);
  inner.value = '';
  emit('update:modelValue', '');
  emit('search', '');
  inputElement.value?.focus();
}

onBeforeUnmount(() => {
  if (timer !== undefined) clearTimeout(timer);
});
</script>

<template>
  <div class="q-search" :class="{ 'q-search--busy': busy }">
    <Search class="q-search__icon" :size="18" aria-hidden="true" />
    <input
      ref="inputElement"
      class="q-search__input"
      type="search"
      :value="inner"
      :placeholder="placeholder ?? t('Suchen …')"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      enterkeyhint="search"
      :aria-busy="busy || undefined"
      :aria-label="t('Aufgaben durchsuchen')"
      @input="onInput"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
      @keydown.enter="searchNow"
    />
    <LoaderCircle v-if="busy" class="q-search__spinner" :size="18" aria-hidden="true" />
    <QIconButton v-if="inner !== ''" class="q-search__clear" :aria-label="t('Suche löschen')" @click="clear"><X :size="18" /></QIconButton>
  </div>
</template>

<style scoped>
.q-search {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--q-border-3);
  border-radius: 10px;
  background: var(--q-card);
  padding: 0 12px;
  min-height: var(--q-control-height);
}
.q-search:focus-within {
  border-color: var(--q-accent);
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-search__icon {
  color: var(--q-faint);
  flex: none;
}
.q-search__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  font: 400 16px 'Public Sans', system-ui, sans-serif;
  color: var(--q-ink);
  outline: none;
}
.q-search__input::-webkit-search-cancel-button {
  display: none;
}
.q-search__clear {
  flex: none;
  margin-inline-end: -10px;
}
@media (hover: hover) and (pointer: fine) {
  .q-search__clear:hover {
    color: var(--q-ink);
  }
}
.q-search__spinner {
  flex: none;
  color: var(--q-accent-strong);
  animation: q-search-spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .q-search__spinner { animation: none; } }
@keyframes q-search-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
