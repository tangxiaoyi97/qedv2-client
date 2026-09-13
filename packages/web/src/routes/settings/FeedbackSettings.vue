<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { ApiError } from '@qed2/core-logic';
import { useAppStore } from '../../stores/app.js';
import { useAuthStore } from '../../stores/auth.js';
import { APP_VERSION, ports } from '../../services.js';
import { useI18n } from '../../i18n.js';
import SettingsCard from './SettingsCard.vue';

const app = useAppStore();
const auth = useAuthStore();
const { t } = useI18n();
const category = ref<'bug' | 'question' | 'suggestion'>('bug');
const subject = ref('');
const message = ref('');
const questionId = ref('');
const consent = ref(false);
const busy = ref(false);
const error = ref('');
const receipt = ref('');
const platform = ports.shell.capabilities.desktop ? 'desktop' : 'web';
let generation = 0;
function clear(): void { subject.value = ''; message.value = ''; questionId.value = ''; consent.value = false; receipt.value = ''; error.value = ''; }
watch(() => [auth.session?.user.id, app.config.serverBaseUrl], () => { generation += 1; clear(); });
onBeforeUnmount(() => { generation += 1; clear(); });

async function submit(): Promise<void> {
  if (busy.value || !auth.isLoggedIn || !consent.value) return;
  busy.value = true; error.value = ''; receipt.value = '';
  const attempt = generation;
  try {
    const result = await app.serverClient.submitFeedback({
      category: category.value, subject: subject.value.trim(), message: message.value.trim(),
      clientVersion: APP_VERSION, platform, ...(questionId.value.trim() ? { questionId: questionId.value.trim() } : {}),
    });
    if (generation !== attempt) return;
    clear(); receipt.value = result.id;
  } catch (caught) {
    if (generation !== attempt) return;
    error.value = caught instanceof ApiError && caught.status === 429 ? t('Zu viele Rückmeldungen. Bitte später erneut versuchen.')
      : caught instanceof ApiError && caught.status === 401 ? t('Bitte erneut anmelden, um eine Rückmeldung zu senden.')
        : t('Übertragung nicht bestätigt. Die Eingaben bleiben erhalten; es wird nicht automatisch erneut gesendet.');
  } finally { busy.value = false; }
}
</script>

<template>
  <SettingsCard :title="t('Feedback')" :description="t('Ein Problem melden oder eine Verbesserung vorschlagen.')">
    <div class="feedback-settings">
      <p v-if="!auth.isLoggedIn" class="feedback-note">{{ t('Melde dich an, um Feedback zu senden.') }}</p>
      <details v-else>
        <summary>{{ t('Rückmeldung verfassen') }}</summary>
        <form @submit.prevent="submit">
          <label for="support-category">{{ t('Kategorie') }}</label>
          <select id="support-category" v-model="category" class="q-settings-field" :disabled="busy"><option value="bug">{{ t('Softwareproblem') }}</option><option value="question">{{ t('Problem mit einer Aufgabe') }}</option><option value="suggestion">{{ t('Verbesserungsvorschlag') }}</option></select>
          <label for="support-subject">{{ t('Betreff') }}</label><input id="support-subject" v-model="subject" class="q-settings-field" required minlength="3" maxlength="120" :disabled="busy" />
          <label for="support-message">{{ t('Beschreibung') }}</label><textarea id="support-message" v-model="message" class="q-settings-field" required minlength="5" maxlength="2000" rows="5" :disabled="busy" aria-describedby="support-data-note" />
          <label for="support-question">{{ t('Aufgaben-ID (optional)') }}</label><input id="support-question" v-model="questionId" class="q-settings-field" maxlength="128" pattern="[A-Za-z0-9._:/@+\-]+" :disabled="busy" />
          <p id="support-data-note" class="feedback-note">{{ t('Bitte keine Passwörter, Schlüssel, Aufgabentexte oder Antworten einfügen. Es werden keine Protokolle oder Lernarchive angehängt.') }}</p>
          <p class="feedback-note">{{ t('Zusätzlich gesendet: Client-Version und Plattform.') }} {{ APP_VERSION }} · {{ platform }}</p>
          <label class="feedback-consent"><input v-model="consent" type="checkbox" required :disabled="busy" /><span>{{ t('Ich möchte diese Beschreibung und die angezeigten Angaben an den Support senden.') }}</span></label>
          <p v-if="error" class="feedback-error" role="alert">{{ error }}</p><p v-if="receipt" class="feedback-success" role="status">{{ t('Feedback gesendet. Referenz:') }} {{ receipt }}</p>
          <button type="submit" :disabled="busy || !consent" :aria-busy="busy">{{ busy ? t('Wird gesendet …') : t('Feedback senden') }}</button>
        </form>
      </details>
    </div>
  </SettingsCard>
</template>

<style scoped>
.feedback-settings { padding: var(--q-settings-block) var(--q-settings-inset); }
.feedback-settings, .feedback-settings * { animation: none !important; transition: none !important; }
summary { cursor: pointer; font-weight: 600; min-height: 44px; padding: 8px 0; }
form { max-width: 720px; }
label:not(.feedback-consent) { display: block; margin: 16px 0 6px; font-size: var(--q-font-ui); font-weight: 600; }
.feedback-note { color: var(--q-mut); font-size: var(--q-font-ui); line-height: 1.65; margin: 14px 0; }
.feedback-consent { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; font-size: var(--q-font-ui); line-height: 1.6; }
.feedback-consent input { flex-shrink: 0; width: 20px; height: 20px; margin-top: 2px; }
button { min-height: 44px; padding: 9px 20px; margin-top: 16px; border: 1px solid var(--q-accent-strong); border-radius: var(--q-radius-control); background: var(--q-accent-strong); color: var(--q-on-accent); font: inherit; cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible, summary:focus-visible { outline: 3px solid var(--q-accent); outline-offset: 3px; }
.feedback-error { color: var(--q-err); }
.feedback-success { color: var(--q-accent-strong); overflow-wrap: anywhere; }
</style>
