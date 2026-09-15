<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, canonicalServiceBaseUrl, parseFeedbackReceipt, type FeedbackIssueType, type FeedbackOptions, type FeedbackSubmission } from '@qed2/core-logic';
import { QButton, QIconButton, useModalA11y } from '@qed2/ui';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useFeedbackStore } from '../stores/feedback.js';
import { useUiStore } from '../stores/ui.js';
import { APP_VERSION, ports } from '../services.js';
import { useI18n } from '../i18n.js';

const app = useAppStore();
const auth = useAuthStore();
const feedback = useFeedbackStore();
const ui = useUiStore();
const { t } = useI18n();
const card = ref<HTMLElement | null>(null);
const target = computed(() => feedback.target);
const open = computed(() => target.value !== null);
const title = computed(() => t(target.value?.scope === 'question' ? 'Aufgabenfeedback' : 'Feedback'));
const platform = ports.shell.capabilities.desktop ? 'desktop' : 'web';
const options = ref<FeedbackOptions | null>(null);
const loading = ref(false);
const busy = ref(false);
const issueType = ref<FeedbackIssueType | ''>('');
const subject = ref('');
const message = ref('');
const error = ref('');
const expired = ref(false);
const receipt = ref('');
const discard = ref(false);
const signInAfterDiscard = ref(false);
const attempted = ref(false);
const initialSubject = ref('');
const submissionId = ref<string | undefined>();
let generation = 0;
let controller: AbortController | undefined;
let editingFocusId: string | undefined;

const QUESTION_ISSUES = ['question_error', 'answer_error', 'numbering_error', 'attachment_error', 'other'] as const;
const SOFTWARE_ISSUES = ['software_error', 'feature_request', 'other'] as const;
const issueLabels: Record<FeedbackIssueType, string> = {
  question_error: 'Fehler in der Aufgabe', answer_error: 'Fehler in der Antwort',
  numbering_error: 'Falsche Nummerierung', attachment_error: 'Fehler in Anhang oder Bild',
  software_error: 'Softwarefehler', feature_request: 'Funktionswunsch', other: 'Sonstiges',
};
const issues = computed(() => target.value?.scope === 'question' ? QUESTION_ISSUES : SOFTWARE_ISSUES);
const authenticated = computed(() => {
  if (!auth.isLoggedIn || !auth.session?.user.id || !auth.session.serverBaseUrl || auth.transitioning) return false;
  try { return canonicalServiceBaseUrl(auth.session.serverBaseUrl) === canonicalServiceBaseUrl(app.config.serverBaseUrl); }
  catch { return false; }
});
const dirty = computed(() => !receipt.value && (subject.value !== initialSubject.value || message.value !== '' || issueType.value !== ''));
const limits = computed(() => options.value?.limits ?? { subjectMin: 3, subjectMax: 120, messageMin: 5, messageMax: 2000 });
const errors = computed(() => ({
  issue: attempted.value && !issues.value.includes(issueType.value as never) ? t('Bitte eine Art auswählen.') : '',
  subject: attempted.value && (subject.value.trim().length < limits.value.subjectMin || subject.value.trim().length > limits.value.subjectMax)
    ? t('Bitte {min} bis {max} Zeichen eingeben.', { min: limits.value.subjectMin, max: limits.value.subjectMax }) : '',
  message: attempted.value && (message.value.trim().length < limits.value.messageMin || message.value.trim().length > limits.value.messageMax)
    ? t('Bitte {min} bis {max} Zeichen eingeben.', { min: limits.value.messageMin, max: limits.value.messageMax }) : '',
}));

useModalA11y(card, open, requestClose);

function invalidate(): void {
  generation += 1;
  controller?.abort(); controller = undefined;
  options.value = null; loading.value = false; busy.value = false;
  issueType.value = ''; subject.value = ''; message.value = '';
  initialSubject.value = ''; error.value = ''; expired.value = false; receipt.value = '';
  discard.value = false; attempted.value = false; submissionId.value = undefined;
  signInAfterDiscard.value = false;
  editingFocusId = undefined;
}

watch(target, () => {
  invalidate();
  if (!target.value) return;
  if (target.value.scope === 'question') {
    initialSubject.value = `${t('Aufgabenfeedback')}: ${target.value.questionId}`.slice(0, 120);
    subject.value = initialSubject.value;
  }
  if (authenticated.value) void loadOptions();
}, { immediate: true, flush: 'sync' });

// A logout, account transition or issuer change destroys the whole report,
// including its retry key. A response from that owner can never update another.
watch([() => auth.session?.user.id, () => auth.session?.serverBaseUrl, () => auth.isLoggedIn, () => auth.transitioning, () => app.config.serverBaseUrl], () => {
  invalidate();
  feedback.close();
}, { flush: 'sync' });
watch(() => JSON.stringify([issueType.value, subject.value.trim(), message.value.trim()]), () => {
  submissionId.value = undefined;
}, { flush: 'sync' });

function supported(value: FeedbackOptions): boolean {
  if (value?.schemaVersion !== 2 || value.idempotent !== true) return false;
  const categories = value.categories;
  if (!categories || !Array.isArray(categories.question) || !Array.isArray(categories.bug) || !Array.isArray(categories.suggestion)) return false;
  if (!QUESTION_ISSUES.every(item => categories.question.includes(item))) return false;
  if (!categories.bug.includes('software_error') || !categories.bug.includes('other') || !categories.suggestion.includes('feature_request')) return false;
  const limit = value.limits;
  return !!limit && [limit.subjectMin, limit.subjectMax, limit.messageMin, limit.messageMax].every(Number.isSafeInteger)
    && limit.subjectMin >= 3 && limit.subjectMax >= limit.subjectMin && limit.subjectMax <= 120
    && limit.messageMin >= 5 && limit.messageMax >= limit.messageMin && limit.messageMax <= 2000;
}

async function loadOptions(): Promise<void> {
  if (loading.value || busy.value || !target.value || !authenticated.value) return;
  const attempt = generation;
  controller?.abort(); controller = new AbortController();
  loading.value = true; error.value = ''; expired.value = false; options.value = null;
  try {
    const result = await app.serverClient.feedbackOptions({ signal: controller.signal });
    if (attempt !== generation) return;
    if (!supported(result)) { error.value = t('Dieser Server unterstützt dieses Feedbackformular noch nicht. Bitte den Server aktualisieren.'); return; }
    options.value = result;
    loading.value = false;
    await nextTick();
    if (attempt === generation && document.activeElement === card.value?.querySelector('#feedback-title')) {
      card.value?.querySelector<HTMLElement>('#feedback-issue')?.focus();
    }
  } catch (caught) {
    if (attempt !== generation) return;
    if (caught instanceof ApiError && [404, 405].includes(caught.status)) {
      error.value = t('Dieser Server unterstützt dieses Feedbackformular noch nicht. Bitte den Server aktualisieren.');
    } else setRequestError(caught);
  } finally { if (attempt === generation) loading.value = false; }
}

function setRequestError(caught: unknown): void {
  if (caught instanceof ApiError && caught.status === 401) {
    expired.value = true;
    error.value = t('Bitte erneut anmelden, um eine Rückmeldung zu senden.');
  } else if (caught instanceof ApiError && caught.status === 429) {
    error.value = t('Zu viele Rückmeldungen. Bitte später erneut versuchen.');
  } else if (caught instanceof ApiError && caught.status === 409) {
    error.value = t('Diese Rückmeldung hat einen Übertragungskonflikt. Die Eingaben bleiben erhalten. Bitte das Formular prüfen und ändern.');
  } else if (caught instanceof ApiError && caught.status === 400) {
    error.value = t('Der Server hat die Angaben abgelehnt. Bitte das Formular prüfen.');
  } else {
    error.value = t('Übertragung nicht bestätigt. Die Eingaben bleiben erhalten; es wird nicht automatisch erneut gesendet.');
  }
}

async function submit(): Promise<void> {
  if (busy.value || loading.value || !options.value || !authenticated.value || expired.value || !target.value) return;
  attempted.value = true; error.value = '';
  if (Object.values(errors.value).some(Boolean)) {
    await nextTick(); card.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return;
  }
  if (app.online === false) { error.value = t('Du bist offline. Die Eingaben bleiben erhalten.'); return; }
  const attempt = generation;
  const selected = issueType.value as FeedbackIssueType;
  const input: FeedbackSubmission = {
    category: target.value.scope === 'question' ? 'question' : selected === 'feature_request' ? 'suggestion' : 'bug',
    issueType: selected, subject: subject.value.trim(), message: message.value.trim(), clientVersion: APP_VERSION, platform,
    ...(target.value.scope === 'question' ? { questionId: target.value.questionId, ...(target.value.context ? { context: { ...target.value.context } } : {}) } : {}),
  };
  busy.value = true;
  controller?.abort(); controller = new AbortController();
  try {
    // Reuse this identity after an uncertain response; only actual report edits
    // invalidate it. The browser never retries the POST on its own.
    submissionId.value ??= crypto.randomUUID();
    const response = await app.serverClient.submitFeedback({ ...input, submissionId: submissionId.value }, { signal: controller.signal });
    if (attempt !== generation) return;
    const result = parseFeedbackReceipt(response);
    receipt.value = result.id;
    subject.value = ''; message.value = ''; issueType.value = '';
    await nextTick(); card.value?.querySelector<HTMLElement>('[data-feedback-receipt]')?.focus();
  } catch (caught) {
    if (attempt === generation) setRequestError(caught);
  } finally { if (attempt === generation) busy.value = false; }
}

function requestClose(): void {
  if (busy.value) return;
  if (discard.value) { void resumeEditing(); return; }
  if (dirty.value) {
    editingFocusId = document.activeElement instanceof HTMLElement ? document.activeElement.id : undefined;
    discard.value = true;
    void nextTick(() => card.value?.querySelector<HTMLElement>('[data-keep-feedback]')?.focus());
  } else feedback.close();
}

async function resumeEditing(): Promise<void> {
  discard.value = false; signInAfterDiscard.value = false;
  await nextTick();
  const previous = editingFocusId ? document.getElementById(editingFocusId) : null;
  (previous && card.value?.contains(previous) ? previous : card.value?.querySelector<HTMLElement>('#feedback-issue'))?.focus();
}

async function signIn(): Promise<void> {
  if (busy.value) return;
  if (dirty.value) {
    editingFocusId = document.activeElement instanceof HTMLElement ? document.activeElement.id : undefined;
    signInAfterDiscard.value = true; discard.value = true;
    await nextTick(); card.value?.querySelector<HTMLElement>('[data-keep-feedback]')?.focus(); return;
  }
  // Authentication can change archive ownership. It is always deliberate and
  // uses the existing modal, leaving the practice route and answer draft intact.
  feedback.close();
  await nextTick(); ui.openAuthModal();
}

async function confirmDiscard(): Promise<void> {
  const login = signInAfterDiscard.value;
  feedback.close();
  if (login) { await nextTick(); ui.openAuthModal(); }
}

function preventUnload(event: BeforeUnloadEvent): void {
  if (!open.value || !dirty.value) return;
  event.preventDefault(); event.returnValue = '';
}
onMounted(() => window.addEventListener('beforeunload', preventUnload));
onBeforeUnmount(() => { invalidate(); window.removeEventListener('beforeunload', preventUnload); });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="feedback-dialog q-modal-backdrop" @click.self="requestClose">
      <section ref="card" class="feedback-dialog__card" role="dialog" aria-modal="true" aria-labelledby="feedback-title" tabindex="-1">
        <header class="feedback-dialog__header">
          <h2 id="feedback-title" tabindex="-1" data-autofocus>{{ title }}</h2>
          <QIconButton :aria-label="t('Schließen')" :disabled="busy" @click="requestClose" />
        </header>

        <div v-if="discard" class="feedback-dialog__state">
          <p>{{ t('Nicht gesendete Rückmeldung verwerfen?') }}</p>
          <div class="feedback-dialog__actions">
            <QButton variant="secondary" data-keep-feedback @click="resumeEditing">{{ t('Weiter bearbeiten') }}</QButton>
            <QButton variant="danger" @click="confirmDiscard">{{ t('Verwerfen') }}</QButton>
          </div>
        </div>
        <div v-else-if="!authenticated" class="feedback-dialog__state">
          <p>{{ t('Melde dich an, um Feedback zu senden.') }}</p>
          <div class="feedback-dialog__actions">
            <QButton variant="secondary" @click="feedback.close()">{{ t('Zurück') }}</QButton>
            <QButton @click="signIn">{{ t('Anmelden') }}</QButton>
          </div>
        </div>
        <div v-else-if="receipt" class="feedback-dialog__state">
          <p data-feedback-receipt tabindex="-1" role="status">{{ t('Feedback gesendet. Referenz:') }} <strong class="feedback-dialog__receipt">{{ receipt }}</strong></p>
          <div class="feedback-dialog__actions"><QButton @click="feedback.close()">{{ t('Fertig') }}</QButton></div>
        </div>
        <form v-else novalidate :aria-busy="busy || loading" @submit.prevent="submit">
          <dl class="feedback-dialog__context">
            <template v-if="target?.scope === 'question'">
              <dt>{{ t('Aufgaben-ID') }}</dt><dd data-feedback-question>{{ target.questionId }}</dd>
              <template v-if="target.context?.partId"><dt>{{ t('Teilaufgabe') }}</dt><dd>{{ target.context.partId }}</dd></template>
              <template v-if="target.context?.coreBaseUrl"><dt>{{ t('Aufgabenquelle') }}</dt><dd>{{ target.context.coreBaseUrl }}</dd></template>
              <template v-if="target.context?.bankCommit"><dt>{{ t('Bank-Commit') }}</dt><dd>{{ target.context.bankCommit }}</dd></template>
              <template v-if="target.context?.contentRevision"><dt>{{ t('Inhaltsversion') }}</dt><dd>{{ target.context.contentRevision }}</dd></template>
            </template>
            <dt>{{ t('Client') }}</dt><dd>{{ APP_VERSION }} · {{ platform }}</dd>
          </dl>
          <p v-if="loading" role="status" class="feedback-dialog__note">{{ t('Feedbackoptionen werden geladen …') }}</p>
          <p v-if="error" id="feedback-error" class="feedback-dialog__error" role="alert">{{ error }}</p>
          <div v-if="expired" class="feedback-dialog__actions"><QButton variant="secondary" @click="signIn">{{ t('Anmelden') }}</QButton></div>
          <div v-else-if="!options && !loading" class="feedback-dialog__actions"><QButton variant="secondary" @click="loadOptions">{{ t('Erneut versuchen') }}</QButton></div>
          <fieldset :disabled="busy || loading || !options || expired">
            <div class="feedback-dialog__field">
              <label for="feedback-issue">{{ t('Art der Rückmeldung') }}</label>
              <select id="feedback-issue" v-model="issueType" required :aria-invalid="errors.issue ? 'true' : undefined" :aria-describedby="errors.issue ? 'feedback-issue-error' : undefined">
                <option disabled value="">{{ t('Bitte auswählen') }}</option>
                <option v-for="issue in issues" :key="issue" :value="issue">{{ t(issueLabels[issue]) }}</option>
              </select>
              <p v-if="errors.issue" id="feedback-issue-error" class="feedback-dialog__error">{{ errors.issue }}</p>
            </div>
            <div class="feedback-dialog__field">
              <label for="feedback-subject">{{ t('Betreff') }}</label>
              <input id="feedback-subject" v-model="subject" required :minlength="limits.subjectMin" :maxlength="limits.subjectMax" :aria-invalid="errors.subject ? 'true' : undefined" :aria-describedby="errors.subject ? 'feedback-subject-error' : undefined" />
              <p v-if="errors.subject" id="feedback-subject-error" class="feedback-dialog__error">{{ errors.subject }}</p>
            </div>
            <div class="feedback-dialog__field">
              <label for="feedback-message">{{ t('Beschreibung') }}</label>
              <textarea id="feedback-message" v-model="message" required rows="5" :minlength="limits.messageMin" :maxlength="limits.messageMax" :aria-invalid="errors.message ? 'true' : undefined" :aria-describedby="errors.message ? 'feedback-message-error feedback-data-note' : 'feedback-data-note'" />
              <p v-if="errors.message" id="feedback-message-error" class="feedback-dialog__error">{{ errors.message }}</p>
              <span class="feedback-dialog__count">{{ message.length }} / {{ limits.messageMax }}</span>
            </div>
            <p id="feedback-data-note" class="feedback-dialog__note">{{ t('Keine Antworten, Bilder oder Protokolle werden automatisch angehängt.') }}</p>
          </fieldset>
          <footer class="feedback-dialog__actions">
            <QButton type="button" variant="secondary" :disabled="busy" @click="requestClose">{{ t('Abbrechen') }}</QButton>
            <QButton type="submit" :disabled="busy || loading || !options || expired" :aria-busy="busy">{{ busy ? t('Wird gesendet …') : t('Feedback senden') }}</QButton>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.feedback-dialog { position: fixed; inset: 0; z-index: 160; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); background: var(--q-scrim, rgb(0 0 0 / .48)); }
.feedback-dialog, .feedback-dialog * { animation: none !important; transition: none !important; }
.feedback-dialog__card { width: min(100%, 620px); min-width: 0; max-height: calc(100dvh - 32px); overflow-y: auto; overscroll-behavior: contain; padding: 22px; border: 1px solid var(--q-border); border-radius: var(--q-radius-card); background: var(--q-card); color: var(--q-ink); box-shadow: var(--q-shadow-modal); }
.feedback-dialog__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.feedback-dialog h2 { font-size: var(--q-font-section, 20px); margin: 0; }
.feedback-dialog__context { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; padding: 14px; border: 1px solid var(--q-border); border-radius: var(--q-radius-control); background: var(--q-panel-2); font-size: var(--q-font-small); line-height: 1.5; margin: 0 0 18px; }
.feedback-dialog dt { color: var(--q-mut); }
.feedback-dialog dd { margin: 0; overflow-wrap: anywhere; }
.feedback-dialog fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.feedback-dialog__field { margin: 14px 0; }
.feedback-dialog__field label { display: block; margin-bottom: 6px; font-size: var(--q-font-ui); font-weight: 600; }
.feedback-dialog__field input, .feedback-dialog__field select, .feedback-dialog__field textarea { box-sizing: border-box; display: block; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--q-border-2); border-radius: var(--q-radius-control); background: var(--q-input-bg, var(--q-card)); color: var(--q-ink); font: inherit; font-size: max(16px, var(--q-font-ui)); }
.feedback-dialog textarea { resize: vertical; }
.feedback-dialog [aria-invalid="true"] { border-color: var(--q-err); }
.feedback-dialog :is(input, select, textarea, button):focus-visible { outline: 3px solid var(--q-accent); outline-offset: 2px; }
.feedback-dialog__count { display: block; text-align: right; margin-top: 4px; color: var(--q-mut); font-size: var(--q-font-small); }
.feedback-dialog__note { color: var(--q-mut); font-size: var(--q-font-small); line-height: 1.6; }
.feedback-dialog__error { color: var(--q-err); font-size: var(--q-font-ui); line-height: 1.55; margin: 8px 0; }
.feedback-dialog__actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
.feedback-dialog__actions :deep(button) { min-height: 44px; }
.feedback-dialog__receipt { display: block; overflow-wrap: anywhere; margin-top: 12px; font-family: monospace; }
.feedback-dialog__state { line-height: 1.6; }
@media (max-width: 420px) { .feedback-dialog__card { padding: 16px; } .feedback-dialog__context { grid-template-columns: 1fr; gap: 3px; } .feedback-dialog dd + dt { margin-top: 7px; } }
</style>
