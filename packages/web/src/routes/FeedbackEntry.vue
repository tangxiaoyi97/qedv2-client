<script setup lang="ts">
import { MessageSquareWarning } from 'lucide-vue-next';
import { useFeedbackStore } from '../stores/feedback.js';
import { useI18n } from '../i18n.js';

defineProps<{ compact?: boolean }>();
const feedback = useFeedbackStore();
const { t } = useI18n();
</script>

<template>
  <button type="button" class="feedback-entry" :class="{ 'feedback-entry--compact': compact }"
    :aria-label="t('Feedback senden')" :title="t('Feedback senden')" aria-haspopup="dialog"
    data-feedback-entry="software" @click="feedback.openSoftware()">
    <MessageSquareWarning :size="20" aria-hidden="true" />
    <span v-if="!compact">{{ t('Feedback') }}</span>
  </button>
</template>

<style scoped>
.feedback-entry { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-width: 44px; min-height: 44px; padding: 8px 14px; border: 1px solid var(--q-border-2); border-radius: var(--q-radius-control); background: var(--q-card); color: var(--q-ink-2); font: inherit; font-size: var(--q-font-ui); font-weight: 600; cursor: pointer; }
.feedback-entry--compact { padding: 8px; }
.feedback-entry:focus-visible { outline: 3px solid var(--q-accent); outline-offset: 3px; }
@media (hover: hover) { .feedback-entry:hover { color: var(--q-accent-strong); background: var(--q-accent-bg); } }
</style>
