<script setup lang="ts">
import { computed, nextTick, ref, toRef, useId, watch } from 'vue';
import { ExternalLink } from 'lucide-vue-next';
import { lookupCompetency, type CompetencyCatalog } from '@qed2/core-logic';
import { useI18n } from '../i18n.js';
import MarkdownView from './MarkdownView.vue';
import QButton from './QButton.vue';
import QIconButton from './QIconButton.vue';
import QSkeleton from './QSkeleton.vue';
import { useModalA11y } from './useModalA11y.js';

const props = defineProps<{
  open: boolean;
  code: string;
  locale: 'de' | 'en';
  catalog: CompetencyCatalog | null;
  loading: boolean;
  error: boolean;
  fallbackDescription?: string | undefined;
}>();
const emit = defineEmits<{
  close: [];
  retry: [];
  localeChange: [locale: 'de' | 'en'];
}>();
const { t } = useI18n();
const titleId = `competency-details-${useId()}`;
const panel = ref<HTMLElement | null>(null);
const scrollBody = ref<HTMLElement | null>(null);
useModalA11y(panel, toRef(props, 'open'), () => emit('close'));

// A pending language change must never label the previous language as current.
const details = computed(() => props.catalog?.locale === props.locale
  ? lookupCompetency(props.catalog, props.code)
  : null);
const fallback = computed(() => props.fallbackDescription?.trim());
const pdfUrl = computed(() => {
  if (!details.value) return undefined;
  try {
    const url = new URL(details.value.catalog.source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const page = details.value.competency.pages[0];
    if (!Number.isInteger(page) || page === undefined || page < 1) return undefined;
    url.hash = `page=${page}`;
    return url.href;
  } catch {
    return undefined;
  }
});

watch(() => [props.open, props.code, props.locale] as const, async () => {
  await nextTick();
  if (scrollBody.value) scrollBody.value.scrollTop = 0;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="competency-dialog">
      <div v-if="open" class="q-competency-dialog q-app q-modal-backdrop" @click.self="emit('close')">
        <section
          ref="panel"
          class="q-competency-dialog__panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <header class="q-competency-dialog__header">
            <div class="q-competency-dialog__heading">
              <p>{{ t('Grundkompetenz') }}</p>
              <h2 :id="titleId">{{ code }}</h2>
            </div>
            <div class="q-competency-dialog__languages" role="group" :aria-label="t('Sprache der Beschreibung')">
              <button type="button" lang="de" aria-label="Deutsch" :aria-pressed="locale === 'de'" @click="emit('localeChange', 'de')">DE</button>
              <button type="button" lang="en" aria-label="English" :aria-pressed="locale === 'en'" @click="emit('localeChange', 'en')">EN</button>
            </div>
            <QIconButton :aria-label="t('Grundkompetenz schließen')" @click="emit('close')" />
          </header>

          <div ref="scrollBody" class="q-competency-dialog__body" :aria-busy="loading ? 'true' : 'false'">
            <template v-if="details">
              <div class="q-competency-dialog__official" :lang="locale">
                <div class="q-competency-dialog__group" role="heading" aria-level="3">
                  <MarkdownView :source="details.group.title" />
                </div>
                <MarkdownView class="q-competency-dialog__description" :source="details.competency.text" />

                <aside v-if="details.footnotes.length" class="q-competency-dialog__footnotes" role="note">
                  <div v-for="(footnote, index) in details.footnotes" :key="`${code}-${locale}-${index}`" class="q-competency-dialog__footnote">
                    <span class="q-competency-dialog__marker" aria-hidden="true">{{ footnote.marker }}</span>
                    <MarkdownView :source="footnote.text" />
                  </div>
                </aside>

                <details v-if="details.comments.length" :key="`${code}-${locale}`" class="q-competency-dialog__notes">
                  <summary tabindex="0">{{ t('Anmerkungen') }}</summary>
                  <MarkdownView v-for="(comment, index) in details.comments" :key="index" :source="comment.text" />
                </details>
              </div>
              <div class="q-competency-dialog__source">
                <span>{{ details.catalog.source.versionLabel }}</span>
                <a v-if="pdfUrl" :href="pdfUrl" target="_blank" rel="noopener noreferrer">
                  {{ t('Offizieller Katalog (PDF)') }} <ExternalLink :size="13" aria-hidden="true" />
                </a>
              </div>
              <div v-if="error" class="q-competency-dialog__error" role="alert">
                <p>{{ t('Der Katalog konnte nicht geladen werden.') }}</p>
                <QButton variant="secondary" @click="emit('retry')">{{ t('Erneut versuchen') }}</QButton>
              </div>
            </template>
            <QSkeleton v-else-if="loading" :rows="4" height="24px" gap="12px" :label="t('Beschreibung wird geladen …')" />
            <template v-else>
              <div v-if="error" class="q-competency-dialog__error" role="alert">
                <p>{{ t('Der Katalog konnte nicht geladen werden.') }}</p>
                <QButton variant="secondary" @click="emit('retry')">{{ t('Erneut versuchen') }}</QButton>
              </div>
              <p v-else class="q-competency-dialog__unavailable" role="status">{{ t('Für diesen Code ist kein offizieller Eintrag verfügbar.') }}</p>
              <div v-if="fallback" class="q-competency-dialog__fallback">
                <p class="q-competency-dialog__fallback-label">{{ t('Beschreibung aus der Aufgabe') }}</p>
                <MarkdownView :source="fallback" />
              </div>
            </template>
          </div>

          <footer class="q-competency-dialog__footer">
            <QButton variant="secondary" @click="emit('close')">{{ t('Schließen') }}</QButton>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.q-competency-dialog {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--q-backdrop, rgba(20, 16, 23, 0.4));
}
.q-competency-dialog__panel {
  width: min(100%, 640px);
  /* Fixed available space keeps loading and language changes from moving the dialog. */
  height: min(680px, calc(100dvh - 48px - var(--q-keyboard-inset, 0px)));
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: var(--q-card);
  color: var(--q-ink);
  box-shadow: 0 18px 70px rgba(0, 0, 0, 0.2);
}
.q-competency-dialog__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 24px 14px;
  flex: none;
}
.q-competency-dialog__heading { flex: 1; min-width: 0; }
.q-competency-dialog__heading p { margin: 0 0 4px; color: var(--q-faint); font-size: 11.5px; }
.q-competency-dialog__heading h2 { margin: 0; font-size: 21px; line-height: 1.2; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.q-competency-dialog__languages { display: flex; flex: none; gap: 2px; }
.q-competency-dialog__languages button {
  min-width: 44px;
  min-height: 44px;
  padding: 0 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--q-faint);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.q-competency-dialog__languages button[aria-pressed='true'] { background: var(--q-accent-bg); color: var(--q-accent-strong); }
.q-competency-dialog__languages button:focus-visible,
.q-competency-dialog__notes summary:focus-visible,
.q-competency-dialog__source a:focus-visible { outline: 2px solid var(--q-accent); outline-offset: 2px; }
.q-competency-dialog__body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 8px 24px 24px;
  overflow-wrap: anywhere;
}
.q-competency-dialog__group { margin-bottom: 18px; }
.q-competency-dialog__group :deep(.q-md) { font-size: 17px; font-weight: 750; line-height: 1.45; color: var(--q-ink); }
.q-competency-dialog__group :deep(.q-md__p) { margin: 0; }
.q-competency-dialog__description.q-md { font-size: 15px; line-height: 1.7; }
.q-competency-dialog__footnotes { margin-top: 20px; padding-left: 12px; border-left: 2px solid var(--q-accent); }
.q-competency-dialog__footnote { display: flex; align-items: flex-start; gap: 7px; min-width: 0; }
.q-competency-dialog__footnote :deep(.q-md) { min-width: 0; font-size: 12.5px; color: var(--q-mut); }
.q-competency-dialog__marker { flex: none; margin-top: 8px; color: var(--q-accent-strong); font-weight: 700; }
.q-competency-dialog__notes { margin-top: 20px; }
.q-competency-dialog__notes summary { min-height: 44px; padding: 10px 0; box-sizing: border-box; font-size: 13px; font-weight: 650; color: var(--q-mut); cursor: pointer; }
.q-competency-dialog__notes :deep(.q-md) { font-size: 13px; color: var(--q-mut); }
.q-competency-dialog__source { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 24px; color: var(--q-faint); font-size: 11.5px; }
.q-competency-dialog__source a { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; color: var(--q-accent-strong); text-decoration: none; }
.q-competency-dialog__source a:hover { text-decoration: underline; }
.q-competency-dialog__error p,
.q-competency-dialog__unavailable { margin: 0 0 14px; color: var(--q-mut); font-size: 13px; line-height: 1.6; }
.q-competency-dialog__fallback { margin-top: 22px; }
.q-competency-dialog__fallback-label { margin: 0 0 8px; font-size: 11.5px; font-weight: 650; color: var(--q-faint); }
.q-competency-dialog__footer { display: flex; justify-content: flex-end; flex: none; padding: 12px 24px; border-top: 1px solid var(--q-border-soft); }
.competency-dialog-enter-active,
.competency-dialog-leave-active { transition: opacity 160ms ease; }
.competency-dialog-enter-active .q-competency-dialog__panel,
.competency-dialog-leave-active .q-competency-dialog__panel { transition: transform 160ms ease; }
.competency-dialog-enter-from,
.competency-dialog-leave-to { opacity: 0; }
.competency-dialog-enter-from .q-competency-dialog__panel,
.competency-dialog-leave-to .q-competency-dialog__panel { transform: translateY(8px); }
.competency-dialog-leave-active { pointer-events: none; }
@media (max-width: 640px) {
  .q-competency-dialog { padding: max(12px, env(safe-area-inset-top)) 0 0; align-items: end; }
  .q-competency-dialog__panel { width: 100%; height: min(680px, calc(100dvh - max(12px, env(safe-area-inset-top)) - var(--q-keyboard-inset, 0px))); border-radius: 18px 18px 0 0; }
  .q-competency-dialog__header { gap: 8px; padding: 16px 16px 12px; }
  .q-competency-dialog__body { padding: 8px 18px 20px; }
  .q-competency-dialog__footer { padding: 12px 18px calc(12px + env(safe-area-inset-bottom)); }
  .q-competency-dialog__footer :deep(.q-btn) { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .competency-dialog-enter-active,
  .competency-dialog-leave-active,
  .competency-dialog-enter-active .q-competency-dialog__panel,
  .competency-dialog-leave-active .q-competency-dialog__panel { transition: none; }
  .competency-dialog-enter-from .q-competency-dialog__panel,
  .competency-dialog-leave-to .q-competency-dialog__panel { transform: none; }
}
</style>
