<script setup lang="ts">
/**
 * Changelog-on-update dialog. Shown once per new build when an archived
 * changelog exists for the running commit (ui store owns the check/fetch).
 */
import { MarkdownView, QButton } from '@qed2/ui';
import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        v-if="ui.changelogOpen"
        class="clog"
        role="dialog"
        aria-modal="true"
        aria-label="Was ist neu"
        @keydown.esc="ui.closeChangelog()"
      >
        <div class="clog__card">
          <div class="clog__head">
            <span class="clog__spark" aria-hidden="true">✦</span>
            <div class="clog__title">Was ist neu</div>
          </div>
          <div class="clog__body">
            <MarkdownView :source="ui.changelogMarkdown ?? ''" />
          </div>
          <div class="clog__footer">
            <QButton @click="ui.closeChangelog()">Verstanden</QButton>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.clog {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 16px;
}
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--q-transition-fast, 0.16s);
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
.clog__card {
  width: 100%;
  max-width: 480px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--q-card);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
  overflow: hidden;
}
.clog__head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 20px 24px 12px;
}
.clog__spark {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--q-chip-bg);
  color: var(--q-accent-strong);
  display: grid;
  place-items: center;
  font-size: 15px;
  flex: none;
}
.clog__title {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.01em;
}
.clog__body {
  padding: 4px 24px 8px;
  overflow-y: auto;
}
.clog__footer {
  display: flex;
  justify-content: flex-end;
  padding: 14px 24px 18px;
  border-top: 1px solid var(--q-border);
  margin-top: 8px;
}
</style>
