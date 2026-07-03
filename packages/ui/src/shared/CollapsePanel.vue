<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
}>();

const open = ref(props.defaultOpen ?? false);
</script>

<template>
  <div class="q-collapse">
    <button class="q-collapse__head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="q-collapse__title">{{ title }}</span>
      <span v-if="subtitle" class="q-collapse__sub">{{ subtitle }}</span>
      <span class="q-collapse__chev" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open" class="q-collapse__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.q-collapse {
  border: 1px solid var(--q-border-2);
  border-radius: 12px;
  overflow: hidden;
}
.q-collapse__head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 13px 16px;
  background: var(--q-panel-2);
  border: none;
  cursor: pointer;
  font-family: inherit;
  color: var(--q-ink);
  text-align: left;
}
.q-collapse__title {
  font-weight: 700;
  font-size: 14px;
}
.q-collapse__sub {
  font-size: 11.5px;
  color: var(--q-mut-2);
}
.q-collapse__chev {
  margin-left: auto;
  color: var(--q-mut-2);
  font-size: 13px;
}
.q-collapse__body {
  padding: 16px 18px;
  border-top: 1px solid var(--q-border-soft);
  background: var(--q-card);
}
</style>
