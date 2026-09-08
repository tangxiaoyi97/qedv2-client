<script setup lang="ts">
/** Shared Web/PWA/Desktop AI settings. */
import { computed, ref, watch } from 'vue';
import { KeyRound, Languages, ShieldCheck, Sparkles, Trash2 } from 'lucide-vue-next';
import { QButton, QChip, QNotice } from '@qed2/ui';
import { useI18n } from '../../i18n.js';
import { useAiStore } from '../../stores/ai.js';
import { useAppStore } from '../../stores/app.js';
import SettingsCard from './SettingsCard.vue';
import SettingsRow from './SettingsRow.vue';

const ai = useAiStore();
const app = useAppStore();
const { t, formatNumber } = useI18n();

const PROVIDERS: { id: 'openai' | 'gemini'; label: string }[] = [
  { id: 'openai', label: 'OpenAI / ChatGPT' },
  { id: 'gemini', label: 'Google Gemini' },
];

const provider = ref<'openai' | 'gemini'>('openai');
const availableProviders = computed(() => {
  const allowed = new Set(ai.capabilities?.providers ?? []);
  return PROVIDERS.filter((item) => allowed.has(item.id));
});
const apiKey = ref('');
const model = ref('');
const credentialEditorOpen = ref(false);
const credentialEditorDismissed = ref(false);
const savingCredential = ref(false);
const credentialError = ref<string | null>(null);
const credentialSaved = ref(false);
const confirmingRemoval = ref(false);
const testingCredential = ref(false);
const credentialTestResult = ref<string | null>(null);
const credentialTestError = ref<string | null>(null);
const credentialRenewRequestId = ref<string | null>(null);

const preferencesOpen = ref(false);
const language = ref(app.config.aiLanguage ?? '');
const customInstructions = ref(ai.customInstructions ?? '');
const savingPreferences = ref(false);
const preferencesSaved = ref(false);
const preferencesError = ref<string | null>(null);

const privacyOpen = ref(false);
const clearing = ref(false);
const cacheCleared = ref(false);
const maintenanceError = ref<string | null>(null);
const refreshingStatus = ref(false);
const sourceError = ref<string | null>(null);
const savingSource = ref(false);
const sourceDraft = ref<'pool' | 'byo'>();
const sourceChoice = computed({
  get: () => sourceDraft.value ?? ai.mode,
  set: (value: 'pool' | 'byo') => { void selectMode(value); },
});

watch(availableProviders, (providers) => {
  if (providers.some((item) => item.id === provider.value)) return;
  const first = providers[0];
  if (first) provider.value = first.id;
}, { immediate: true });
watch(() => ai.customInstructions, (value) => {
  if (!preferencesOpen.value) customInstructions.value = value;
});

const status = computed(() => ai.status);
const configured = computed(() => status.value?.byo.configured === true);
const pool = computed(() => status.value?.pool);
const showCredentialEditor = computed(
  () =>
    ai.byoOffered &&
    availableProviders.value.length > 0 &&
    (credentialEditorOpen.value ||
      (ai.mode === 'byo' &&
        !!status.value &&
        !configured.value &&
        !credentialEditorDismissed.value)),
);
const showSourceChooser = computed(
  () => !!status.value && ai.poolOffered && ai.byoOffered,
);
const sourceUnavailable = computed(
  () => !!status.value && ai.mode === 'pool' && !ai.poolOffered && ai.byoOffered,
);

type ReadinessTone = 'accent' | 'neutral' | 'warn';

const readiness = computed<{ label: string; tone: ReadinessTone }>(() => {
  if (ai.statusError) return { label: t('Status fehlt'), tone: 'warn' };
  if (!status.value) return { label: t('Lädt'), tone: 'neutral' };
  if (!status.value.features.explain && !status.value.features.assess) {
    return { label: t('Nicht verfügbar'), tone: 'warn' };
  }
  if (ai.mode === 'pool') {
    return ai.poolOffered
      ? { label: t('Bereit'), tone: 'accent' }
      : { label: t('Quelle wählen'), tone: 'warn' };
  }
  if (!ai.byoOffered) return { label: t('Nicht verfügbar'), tone: 'warn' };
  return configured.value
    ? { label: t('Bereit'), tone: 'accent' }
    : { label: t('Einrichten'), tone: 'warn' };
});

function providerLabel(value: string | undefined): string {
  if (value === 'gemini') return 'Google Gemini';
  if (value === 'openai') return 'OpenAI';
  return t('Anbieter offen');
}

const featureLabel = computed(() => {
  if (!status.value) return t('Wird geladen …');
  const { explain, assess } = status.value.features;
  if (explain && assess) return t('Erklären · Bewerten');
  if (explain) return t('Erklären');
  if (assess) return t('Bewerten');
  return t('Nicht freigeschaltet');
});

const credentialSummary = computed(() => {
  if (!configured.value) return t('Nicht eingerichtet');
  const route = status.value?.byo;
  const parts = [t('Verschlüsselt'), providerLabel(route?.provider)];
  if (route?.model) parts.push(route.model);
  if (route?.last4) parts.push(`•••• ${route.last4}`);
  return parts.join(' · ');
});

const preferenceSummary = computed(() => {
  const parts = [language.value.trim() || t('Standardsprache')];
  if (customInstructions.value.trim()) parts.push(t('eigene Hinweise'));
  return parts.join(' · ');
});

const privacyRecipient = computed(() => {
  const route = ai.mode === 'pool' ? status.value?.pool : status.value?.byo;
  const label = providerLabel(route?.provider);
  return label === t('Anbieter offen') ? t('den gewählten KI-Anbieter') : label;
});

const poolQuotaLabel = computed(() => {
  const remaining = pool.value?.remaining;
  if (remaining?.tokens !== undefined) {
    return t('{count} Token', { count: formatNumber(remaining.tokens) });
  }
  if (remaining?.costCents !== undefined) {
    return formatNumber(remaining.costCents / 100, {
      style: 'currency',
      currency: 'EUR',
    });
  }
  return t('Verfügbar');
});

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? t(error.message) : fallback;
}

async function selectMode(next: 'pool' | 'byo'): Promise<void> {
  if (savingSource.value || next === ai.mode) return;
  sourceDraft.value = next;
  savingSource.value = true;
  credentialSaved.value = false;
  confirmingRemoval.value = false;
  sourceError.value = null;
  try {
    await ai.setMode(next);
  } catch (error) {
    sourceError.value = messageOf(error, t('Die KI-Quelle konnte nicht gespeichert werden.'));
  } finally {
    sourceDraft.value = undefined;
    savingSource.value = false;
  }
}

function toggleCredentialEditor(): void {
  if (showCredentialEditor.value) {
    credentialEditorOpen.value = false;
    credentialEditorDismissed.value = true;
    apiKey.value = '';
  } else {
    credentialEditorOpen.value = true;
    credentialEditorDismissed.value = false;
    const configuredProvider = status.value?.byo.provider;
    provider.value = availableProviders.value.some((item) => item.id === configuredProvider)
      ? configuredProvider as 'openai' | 'gemini'
      : availableProviders.value[0]?.id ?? 'openai';
    model.value = status.value?.byo.model ?? '';
  }
  credentialError.value = null;
  credentialSaved.value = false;
  confirmingRemoval.value = false;
}

function togglePreferences(): void {
  preferencesOpen.value = !preferencesOpen.value;
  preferencesError.value = null;
  preferencesSaved.value = false;
}

async function retryStatus(): Promise<void> {
  if (refreshingStatus.value) return;
  refreshingStatus.value = true;
  try {
    await ai.refreshStatus();
  } finally {
    refreshingStatus.value = false;
  }
}

async function saveCredential(): Promise<void> {
  if (
    !apiKey.value.trim()
    || savingCredential.value
    || testingCredential.value
    || !availableProviders.value.some((item) => item.id === provider.value)
  ) return;
  savingCredential.value = true;
  credentialError.value = null;
  credentialSaved.value = false;
  try {
    await ai.saveCredential({
      provider: provider.value,
      apiKey: apiKey.value.trim(),
      ...(model.value.trim() ? { model: model.value.trim() } : {}),
    });
    // Secrets must not remain in the DOM after reaching the server.
    apiKey.value = '';
    credentialSaved.value = true;
  } catch (error) {
    credentialError.value = messageOf(error, t('Der Schlüssel konnte nicht gespeichert werden.'));
  } finally {
    savingCredential.value = false;
  }
}

async function removeCredential(): Promise<void> {
  if (savingCredential.value || testingCredential.value) return;
  savingCredential.value = true;
  credentialError.value = null;
  try {
    await ai.deleteCredential();
    apiKey.value = '';
    credentialSaved.value = false;
    confirmingRemoval.value = false;
    credentialEditorOpen.value = false;
    credentialEditorDismissed.value = true;
  } catch (error) {
    credentialError.value = messageOf(error, t('Der Schlüssel konnte nicht entfernt werden.'));
  } finally {
    savingCredential.value = false;
  }
}

async function testCredential(options: { newRequest?: boolean } = {}): Promise<void> {
  if (testingCredential.value || savingCredential.value) return;
  testingCredential.value = true;
  credentialTestResult.value = null;
  credentialTestError.value = null;
  if (!options.newRequest) credentialRenewRequestId.value = null;
  try {
    const response = await ai.testCredential(options.newRequest
      ? {
          newRequest: true,
          expectedClientRequestId: credentialRenewRequestId.value ?? undefined,
        }
      : {});
    credentialTestResult.value = t('Verbunden · {provider} · {model}', { provider: providerLabel(response.provider), model: response.model });
    credentialRenewRequestId.value = null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'AI_REQUEST_ALREADY_COMPLETED') {
      credentialRenewRequestId.value = (error as { credentialRequestId?: string }).credentialRequestId ?? null;
    }
    credentialTestError.value = code === 'AI_REQUEST_ALREADY_COMPLETED'
      ? t('Der Test wurde ausgeführt, aber die Antwort ging verloren. Er wird nicht automatisch wiederholt.')
      : code === 'AI_REQUEST_IN_PROGRESS'
        ? t('Der Verbindungstest läuft noch.')
        : messageOf(error, t('Die Verbindung konnte nicht bestätigt werden.'));
  } finally {
    testingCredential.value = false;
  }
}

function markPreferencesDirty(): void {
  preferencesSaved.value = false;
  preferencesError.value = null;
}

async function savePreferences(): Promise<void> {
  if (savingPreferences.value) return;
  savingPreferences.value = true;
  preferencesSaved.value = false;
  preferencesError.value = null;
  try {
    await Promise.all([
      app.updateConfig({ aiLanguage: language.value.trim().slice(0, 80) }),
      ai.savePromptPreferences({
        customInstructions: customInstructions.value.trim().slice(0, 600),
      }),
    ]);
    preferencesSaved.value = true;
  } catch (error) {
    preferencesError.value = messageOf(error, t('Der Antwortstil konnte nicht gespeichert werden.'));
  } finally {
    savingPreferences.value = false;
  }
}

async function clearCache(): Promise<void> {
  if (clearing.value) return;
  clearing.value = true;
  cacheCleared.value = false;
  maintenanceError.value = null;
  try {
    await ai.clearCache();
    cacheCleared.value = true;
  } catch (error) {
    maintenanceError.value = messageOf(error, t('Die gespeicherten Antworten konnten nicht gelöscht werden.'));
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div v-if="ai.available" id="ai-settings" class="ai-settings settings__section" tabindex="-1">
    <SettingsCard :title="t('KI-Erklärungen')">
      <template #action>
        <span role="status" aria-live="polite">
          <QChip :tone="readiness.tone">
            <Sparkles :size="14" aria-hidden="true" />
            {{ readiness.label }}
          </QChip>
        </span>
      </template>

      <QNotice v-if="ai.statusError" class="ai-settings__notice" tone="error">
        {{ t('KI-Status konnte nicht geladen werden: {message}', { message: t(ai.statusError) }) }}
        <template #action>
          <QButton variant="secondary" :disabled="refreshingStatus" @click="retryStatus">
            {{ refreshingStatus ? t('Wird geladen …') : t('Erneut laden') }}
          </QButton>
        </template>
      </QNotice>

      <SettingsRow v-else-if="!status" :label="t('Status')">
        <span class="ai-settings__value" role="status" aria-live="polite">{{ t('Wird geladen …') }}</span>
      </SettingsRow>

      <template v-else>
        <SettingsRow :label="t('Funktionen')">
          <span class="ai-settings__value">
            <Sparkles :size="16" aria-hidden="true" />
            {{ featureLabel }}
          </span>
        </SettingsRow>

        <SettingsRow v-if="showSourceChooser" class="ai-settings__source-row" :label="t('Quelle')">
          <template #default="{ labelId }">
            <div class="ai-settings__segments q-settings-segments" role="radiogroup" :aria-labelledby="labelId" :aria-busy="savingSource">
              <label
                class="ai-settings__segment q-settings-segment"
                :class="{ 'ai-settings__segment--on': sourceChoice === 'byo' }"
              >
                <input
                  class="ai-settings__choice-input"
                  type="radio"
                  name="ai-source"
                  value="byo"
                  v-model="sourceChoice"
                  :disabled="savingSource"
                />
                <span>{{ t('Eigener Schlüssel') }}</span>
              </label>
              <label
                class="ai-settings__segment q-settings-segment"
                :class="{ 'ai-settings__segment--on': sourceChoice === 'pool' }"
              >
                <input
                  class="ai-settings__choice-input"
                  type="radio"
                  name="ai-source"
                  value="pool"
                  v-model="sourceChoice"
                  :disabled="savingSource"
                />
                <span>Server</span>
              </label>
            </div>
          </template>
        </SettingsRow>

        <QNotice v-if="sourceUnavailable" class="ai-settings__notice">
          {{ t('Server-Kontingent nicht verfügbar.') }}
          <template #action>
            <QButton variant="secondary" @click="selectMode('byo')">
              {{ t('Eigenen Schlüssel verwenden') }}
            </QButton>
          </template>
        </QNotice>

        <QNotice v-if="sourceError" class="ai-settings__notice" tone="error">
          {{ sourceError }}
        </QNotice>

        <SettingsRow v-if="ai.mode === 'pool' && pool?.eligible" :label="t('Kontingent')">
          <span class="ai-settings__value" role="status">{{ poolQuotaLabel }}</span>
        </SettingsRow>

        <SettingsRow v-if="ai.byoOffered || configured" :label="t('API-Schlüssel')">
          <template #description>{{ credentialSummary }}</template>
          <template v-if="configured && !ai.byoOffered" #status>
            <span class="ai-settings__secure">
              <ShieldCheck :size="14" aria-hidden="true" />
              {{ t('Gespeichert · nicht verfügbar') }}
            </span>
          </template>
          <div
            v-if="!ai.byoOffered && configured && confirmingRemoval"
            class="ai-settings__confirm"
            role="group"
            :aria-label="t('Schlüssel wirklich entfernen')"
          >
            <span>{{ t('Schlüssel entfernen?') }}</span>
            <QButton variant="ghost" :disabled="savingCredential" @click="confirmingRemoval = false">
              {{ t('Abbrechen') }}
            </QButton>
            <QButton variant="danger" :disabled="savingCredential" @click="removeCredential">
              {{ savingCredential ? t('Wird entfernt …') : t('Entfernen') }}
            </QButton>
          </div>
          <QButton
            v-else-if="!ai.byoOffered && configured"
            variant="danger"
            :disabled="savingCredential"
            @click="confirmingRemoval = true"
          >
            <span class="ai-settings__button-content">
              <Trash2 :size="16" aria-hidden="true" />
              {{ t('Entfernen') }}
            </span>
          </QButton>
          <QButton
            v-else
            variant="secondary"
            :aria-expanded="showCredentialEditor"
            :disabled="savingCredential"
            aria-controls="ai-credential-editor"
            @click="toggleCredentialEditor"
          >
            <span class="ai-settings__button-content">
              <KeyRound :size="16" aria-hidden="true" />
              {{ showCredentialEditor ? t('Schließen') : configured ? t('Ändern') : t('Einrichten') }}
            </span>
          </QButton>
        </SettingsRow>

        <SettingsRow v-if="ai.canTestCredential && ai.mode === 'byo'" :label="t('Verbindung')">
          <template v-if="credentialTestResult" #description>
            <span role="status">{{ credentialTestResult }}</span>
          </template>
          <QButton variant="secondary" :disabled="testingCredential || savingCredential" :aria-busy="testingCredential" @click="testCredential()">
            {{ testingCredential ? t('Wird getestet …') : t('Verbindung testen') }}
          </QButton>
        </SettingsRow>

        <QNotice v-if="credentialTestError" class="ai-settings__notice" tone="error">
          {{ credentialTestError }}
          <template v-if="credentialRenewRequestId" #action>
            <QButton
              variant="secondary"
              :disabled="testingCredential"
              @click="testCredential({ newRequest: true })"
            >
              {{ t('Neu testen (kann erneut kosten)') }}
            </QButton>
          </template>
        </QNotice>

        <form
          v-if="showCredentialEditor"
          id="ai-credential-editor"
          class="ai-settings__editor"
          :aria-label="t('Eigenen KI-Schlüssel einrichten')"
          @submit.prevent="saveCredential"
        >
          <SettingsRow :label="t('Anbieter')">
            <template #default="{ labelId }">
              <select v-model="provider" class="ai-settings__input q-settings-field" :aria-labelledby="labelId" :disabled="savingCredential">
                <option v-for="item in availableProviders" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </template>
          </SettingsRow>

          <SettingsRow :label="configured ? t('Neuer API-Schlüssel') : t('API-Schlüssel')">
            <template #default="{ labelId }">
              <input
                id="ai-key"
                v-model="apiKey"
                type="password"
                class="ai-settings__input q-settings-field"
                maxlength="512"
                autocomplete="off"
                autocapitalize="off"
                :disabled="savingCredential"
                spellcheck="false"
                :placeholder="t('API-Schlüssel')"
                :aria-labelledby="labelId"
                @input="credentialSaved = false"
              />
            </template>
          </SettingsRow>

          <SettingsRow :label="t('Modell (optional)')">
            <template #default="{ labelId }">
              <input
                id="ai-model"
                v-model="model"
                type="text"
                maxlength="200"
                class="ai-settings__input q-settings-field"
                spellcheck="false"
                :placeholder="t('Standardmodell')"
                :disabled="savingCredential"
                :aria-labelledby="labelId"
              />
            </template>
          </SettingsRow>

          <QNotice v-if="credentialError" class="ai-settings__notice" tone="error">
            {{ credentialError }}
          </QNotice>

          <div class="ai-settings__editor-actions">
            <span v-if="credentialSaved" class="ai-settings__saved" role="status">
              {{ t('Schlüssel gespeichert.') }}
            </span>

            <div
              v-if="confirmingRemoval"
              class="ai-settings__confirm"
              role="group"
              :aria-label="t('Schlüssel wirklich entfernen')"
            >
              <span>{{ t('Schlüssel entfernen?') }}</span>
              <QButton variant="ghost" :disabled="savingCredential" @click="confirmingRemoval = false">
                {{ t('Abbrechen') }}
              </QButton>
              <QButton variant="danger" :disabled="savingCredential" @click="removeCredential">
                {{ savingCredential ? t('Wird entfernt …') : t('Entfernen') }}
              </QButton>
            </div>

            <template v-else>
              <QButton
                v-if="configured"
                variant="danger"
                :disabled="savingCredential"
                @click="confirmingRemoval = true"
              >
                <span class="ai-settings__button-content">
                  <Trash2 :size="16" aria-hidden="true" />
                  {{ t('Entfernen') }}
                </span>
              </QButton>
              <QButton type="submit" :disabled="!apiKey.trim() || savingCredential || testingCredential">
                {{ savingCredential ? t('Wird gespeichert …') : t('Speichern') }}
              </QButton>
            </template>
          </div>
        </form>

        <SettingsRow :label="t('Antwortstil')">
          <template #description>{{ preferenceSummary }}</template>
          <QButton
            variant="secondary"
            :aria-expanded="preferencesOpen"
            :disabled="savingPreferences"
            aria-controls="ai-preferences-editor"
            @click="togglePreferences"
          >
            <span class="ai-settings__button-content">
              <Languages :size="16" aria-hidden="true" />
              {{ preferencesOpen ? t('Schließen') : t('Bearbeiten') }}
            </span>
          </QButton>
        </SettingsRow>

        <form
          v-if="preferencesOpen"
          id="ai-preferences-editor"
          class="ai-settings__editor"
          :aria-label="t('Antwortstil der KI')"
          @submit.prevent="savePreferences"
        >
          <SettingsRow :label="t('Sprache')">
            <template #default="{ labelId }">
              <input
                id="ai-language"
                v-model="language"
                type="text"
                maxlength="80"
                class="ai-settings__input q-settings-field"
                :placeholder="t('Deutsch')"
                :disabled="savingPreferences"
                :aria-labelledby="labelId"
                @input="markPreferencesDirty"
              />
            </template>
          </SettingsRow>
          <SettingsRow :label="t('Hinweise (optional)')" layout="stacked">
            <template #default="{ labelId }">
              <textarea
                id="ai-instructions"
                v-model="customInstructions"
                maxlength="600"
                rows="3"
                class="ai-settings__input ai-settings__textarea q-settings-field"
                :placeholder="t('Kurz und mit einem Beispiel erklären.')"
                :aria-labelledby="labelId"
                aria-describedby="ai-instructions-count"
                :disabled="savingPreferences"
                @input="markPreferencesDirty"
              />
              <span id="ai-instructions-count" class="ai-settings__count">
                {{ customInstructions.length }}/600
              </span>
            </template>
          </SettingsRow>

          <QNotice v-if="preferencesError" class="ai-settings__notice" tone="error">
            {{ preferencesError }}
          </QNotice>
          <div class="ai-settings__editor-actions">
            <span v-if="preferencesSaved" class="ai-settings__saved" role="status">
              {{ t('Antwortstil gespeichert.') }}
            </span>
            <QButton type="submit" :disabled="savingPreferences">
              {{ savingPreferences ? t('Wird gespeichert …') : t('Speichern') }}
            </QButton>
          </div>
        </form>

        <SettingsRow :label="t('Datenschutz')">
          <QButton
            variant="secondary"
            :aria-expanded="privacyOpen"
            aria-controls="ai-privacy-details"
            @click="privacyOpen = !privacyOpen"
          >
            <span class="ai-settings__button-content">
              <ShieldCheck :size="16" aria-hidden="true" />
              {{ privacyOpen ? t('Schließen') : t('Details') }}
            </span>
          </QButton>
        </SettingsRow>

        <div v-if="privacyOpen" id="ai-privacy-details" class="ai-settings__privacy">
          <p>
            <strong>{{ t('Nur nach deinem Klick:') }}</strong>
            {{ t('Aufgabe, Musterlösung und deine Antwort gehen an {provider}.', { provider: privacyRecipient }) }}
          </p>
          <p><strong>{{ t('Nicht übertragen:') }}</strong> {{ t('Konto, Lernfortschritt und Statistiken.') }}</p>
        </div>

        <SettingsRow :label="t('KI-Cache')">
          <template v-if="cacheCleared" #status>
            <span class="ai-settings__saved" role="status">{{ t('Geleert.') }}</span>
          </template>
          <QButton variant="secondary" :disabled="clearing" @click="clearCache">
            {{ clearing ? t('Wird geleert …') : t('Leeren') }}
          </QButton>
        </SettingsRow>

        <QNotice v-if="maintenanceError" class="ai-settings__notice" tone="error">
          {{ maintenanceError }}
        </QNotice>
      </template>
    </SettingsCard>
  </div>
</template>

<style scoped>
.ai-settings {
  min-width: 0;
}

.ai-settings :deep(.q-settings-row--inline) {
  grid-template-columns: minmax(0, 1fr) auto;
}

.ai-settings :deep(.q-settings-row__description) {
  overflow-wrap: anywhere;
}

.ai-settings__notice { margin: var(--q-settings-block) var(--q-settings-inset); }

.ai-settings__value,
.ai-settings__secure,
.ai-settings__button-content {
  display: inline-flex;
  align-items: center;
  gap: var(--q-space-2);
}

.ai-settings__value {
  color: var(--q-ink-2);
  font-size: var(--q-font-ui);
  font-weight: 600;
  white-space: nowrap;
}

.ai-settings__secure,
.ai-settings__saved {
  color: var(--q-ok-ink);
  font-size: var(--q-font-small);
  font-weight: 700;
}

.ai-settings__segments {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ai-settings__segment--on {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}

.ai-settings__choice-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.ai-settings__editor :deep(.q-settings-row--inline) {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
}
.ai-settings__editor :deep(.q-settings-row__control) {
  width: 100%;
  justify-self: stretch;
}

.ai-settings__editor {
  border-top: 1px solid var(--q-border-soft);
  border-bottom: 1px solid var(--q-border-soft);
  background: var(--q-panel);
}


.ai-settings__editor :deep(.q-settings-row--stacked .q-settings-row__control) {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
}

.ai-settings__input { width: 100%; }



.ai-settings__count {
  display: block;
  margin-top: var(--q-space-1);
  color: var(--q-faint);
  font: 500 var(--q-font-small)/1.5 ui-monospace, Menlo, monospace;
  text-align: right;
}

.ai-settings__editor-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--q-space-2);
  min-height: var(--q-control-height);
  padding: var(--q-settings-block) var(--q-settings-inset);
  flex-wrap: wrap;
}

.ai-settings__saved {
  margin-right: auto;
}

.ai-settings__confirm {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--q-space-2);
  color: var(--q-err-ink);
  font-size: var(--q-font-small);
  font-weight: 700;
  flex-wrap: wrap;
}

.ai-settings__privacy {
  padding: var(--q-settings-block) var(--q-settings-inset);
  border-top: 1px solid var(--q-border-soft);
  border-bottom: 1px solid var(--q-border-soft);
  background: var(--q-panel);
  color: var(--q-mut);
  font-size: var(--q-font-small);
  line-height: 1.55;
}

.ai-settings__privacy p {
  margin: 0;
}

.ai-settings__privacy p + p {
  margin-top: var(--q-space-1);
}

.ai-settings__privacy strong {
  color: var(--q-ink);
}

@media (hover: hover) and (pointer: fine) {
  .ai-settings__segment:not(.ai-settings__segment--on):hover {
    background: var(--q-panel-2);
    color: var(--q-ink);
  }
}

@media (max-width: 520px) {
  .ai-settings :deep(.ai-settings__source-row) {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }

  .ai-settings__source-row :deep(.q-settings-row__control) {
    width: 100%;
    justify-self: stretch;
  }

  .ai-settings__segments {
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
  }

  .ai-settings__value {
    white-space: normal;
  }

  .ai-settings__segments,
  .ai-settings__input {
    width: 100%;
  }

  .ai-settings__editor :deep(.q-settings-row--inline) {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }

  .ai-settings__editor :deep(.q-settings-row__control) {
    width: 100%;
    justify-self: stretch;
  }

  .ai-settings__editor-actions,
  .ai-settings__confirm {
    gap: var(--q-space-2);
  }

  .ai-settings__saved {
    flex-basis: 100%;
  }
}
</style>
