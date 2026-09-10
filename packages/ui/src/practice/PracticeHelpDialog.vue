<script setup lang="ts">
import { ref, useId } from 'vue';
import { Sparkles } from 'lucide-vue-next';
import { useI18n } from '../i18n.js';
import QButton from '../shared/QButton.vue';
import QIconButton from '../shared/QIconButton.vue';
import { useModalA11y } from '../shared/useModalA11y.js';

defineProps<{ title: string; context?: string; returnLabel: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const titleId = `practice-help-${useId()}`;
const panel = ref<HTMLElement | null>(null);
useModalA11y(panel, ref(true), () => emit('close'));
</script>

<template>
  <Teleport to="body">
    <div class="practice-help q-app q-modal-backdrop" @click.self="emit('close')">
      <section ref="panel" class="practice-help__dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-label="title" tabindex="-1">
        <header class="practice-help__header">
          <Sparkles :size="20" aria-hidden="true" />
          <div class="practice-help__heading">
            <h2 :id="titleId">{{ title }}</h2>
            <p v-if="context">{{ context }}</p>
          </div>
          <QIconButton :aria-label="t('{title} schließen', { title })" @click="emit('close')" />
        </header>
        <div class="practice-help__body"><slot /></div>
        <footer class="practice-help__footer">
          <QButton variant="secondary" @click="emit('close')">{{ returnLabel }}</QButton>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.practice-help {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--q-backdrop, rgba(20, 16, 23, 0.4));
}
.practice-help__dialog {
  width: min(100%, 680px);
  max-height: min(820px, calc(100dvh - 48px - var(--q-keyboard-inset, 0px)));
  min-height: 240px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: var(--q-card);
  color: var(--q-ink);
  box-shadow: 0 18px 70px rgba(0, 0, 0, 0.2);
}
.practice-help__header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 22px 24px 16px;
  flex: none;
}
.practice-help__header > svg { color: var(--q-accent-strong); margin-top: 5px; flex: none; }
.practice-help__heading { flex: 1; min-width: 0; }
.practice-help__heading h2 { margin: 0; font-size: 19px; letter-spacing: -0.02em; }
.practice-help__heading p { margin: 5px 0 0; color: var(--q-faint); font-size: 12px; overflow-wrap: anywhere; }
.practice-help__body { padding: 8px 24px 24px; overflow-y: auto; min-height: 0; overscroll-behavior: contain; }
.practice-help__footer { display: flex; justify-content: flex-end; padding: 14px 24px; border-top: 1px solid var(--q-border-soft); flex: none; }
@media (max-width: 640px) {
  .practice-help { padding: max(12px, env(safe-area-inset-top)) 0 0; align-items: end; }
  .practice-help__dialog { width: 100%; max-height: calc(100dvh - max(12px, env(safe-area-inset-top)) - var(--q-keyboard-inset, 0px)); border-radius: 18px 18px 0 0; }
  .practice-help__header { padding: 18px 18px 14px; }
  .practice-help__body { padding: 8px 18px 22px; }
  .practice-help__footer { padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); }
  .practice-help__footer :deep(.q-btn) { width: 100%; }
}
</style>
