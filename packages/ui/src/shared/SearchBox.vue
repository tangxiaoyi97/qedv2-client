<script setup lang="ts">
/**
 * Debounced global search input (search upgrade doc §1). Emits `search` only
 * after the debounce window; clearing emits an empty string immediately so
 * the host can switch straight back to the normal browse view.
 */
import { onBeforeUnmount, ref, watch } from 'vue';

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
  if (value.trim() === '') {
    emit('search', '');
    return;
  }
  timer = setTimeout(() => emit('search', value.trim()), props.debounceMs ?? 300);
}

function clear(): void {
  if (timer !== undefined) clearTimeout(timer);
  inner.value = '';
  emit('update:modelValue', '');
  emit('search', '');
}

onBeforeUnmount(() => {
  if (timer !== undefined) clearTimeout(timer);
});
</script>

<template>
  <div class="q-search" :class="{ 'q-search--busy': busy }">
    <svg class="q-search__icon" width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <line x1="10.2" y1="10.2" x2="13.6" y2="13.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
    <input
      class="q-search__input"
      type="search"
      :value="inner"
      :placeholder="placeholder ?? 'Suchen …'"
      spellcheck="false"
      autocomplete="off"
      aria-label="Aufgaben durchsuchen"
      @input="onInput"
    />
    <span v-if="busy" class="q-search__spinner" aria-hidden="true">⟳</span>
    <button v-else-if="inner !== ''" type="button" class="q-search__clear" aria-label="Suche löschen" @click="clear">
      ✕
    </button>
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
  height: 42px;
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
  font: 400 14px 'Public Sans', system-ui, sans-serif;
  color: var(--q-ink);
  outline: none;
}
.q-search__input::-webkit-search-cancel-button {
  display: none;
}
.q-search__clear {
  border: none;
  background: none;
  color: var(--q-faint);
  cursor: pointer;
  font-size: 13px;
  padding: 4px;
}
@media (hover: hover) and (pointer: fine) {
  .q-search__clear:hover {
    color: var(--q-ink);
  }
}
.q-search__spinner {
  color: var(--q-accent-strong);
  animation: q-search-spin 1s linear infinite;
}
@keyframes q-search-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
