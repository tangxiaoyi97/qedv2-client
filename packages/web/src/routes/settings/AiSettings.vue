<script setup lang="ts">
/** Shared Web/PWA/Desktop AI settings. */
import { computed, ref } from 'vue';
import { KeyRound, Languages, ShieldCheck, Sparkles, Trash2 } from 'lucide-vue-next';
import { QButton, QChip, QNotice } from '@qed2/ui';
import { useAiStore } from '../../stores/ai.js';
import { useAppStore } from '../../stores/app.js';
import SettingsCard from './SettingsCard.vue';
import SettingsRow from './SettingsRow.vue';

const ai = useAiStore();
const app = useAppStore();

const PROVIDERS: { id: 'openai' | 'gemini'; label: string }[] = [
  { id: 'openai', label: 'OpenAI / ChatGPT' },
  { id: 'gemini', label: 'Google Gemini' },
];

const provider = ref<'openai' | 'gemini'>('openai');
const apiKey = ref('');
const model = ref('');
const credentialEditorOpen = ref(false);
const credentialEditorDismissed = ref(false);
const savingCredential = ref(false);
const credentialError = ref<string | null>(null);
const credentialSaved = ref(false);
const confirmingRemoval = ref(false);

const preferencesOpen = ref(false);
const language = ref(app.config.aiLanguage ?? '');
const customInstructions = ref(app.config.aiCustomInstructions ?? '');
const savingPreferences = ref(false);
const preferencesSaved = ref(false);
const preferencesError = ref<string | null>(null);

const privacyOpen = ref(false);
const clearing = ref(false);
const cacheCleared = ref(false);
const maintenanceError = ref<string | null>(null);
const refreshingStatus = ref(false);

const status = computed(() => ai.status);
const configured = computed(() => status.value?.byo.configured === true);
const pool = computed(() => status.value?.pool);
const showCredentialEditor = computed(
  () =>
    ai.byoOffered &&
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
  if (ai.statusError) return { label: 'Status nicht verfügbar', tone: 'warn' };
  if (!status.value) return { label: 'Wird geladen', tone: 'neutral' };
  if (!status.value.features.explain && !status.value.features.assess) {
    return { label: 'Nicht verfügbar', tone: 'warn' };
  }
  if (ai.mode === 'pool') {
    return ai.poolOffered
      ? { label: 'Einsatzbereit', tone: 'accent' }
      : { label: 'Quelle wählen', tone: 'warn' };
  }
  if (!ai.byoOffered) return { label: 'Nicht verfügbar', tone: 'warn' };
  return configured.value
    ? { label: 'Einsatzbereit', tone: 'accent' }
    : { label: 'Einrichtung nötig', tone: 'warn' };
});

function providerLabel(value: string | undefined): string {
  if (value === 'gemini') return 'Google Gemini';
  if (value === 'openai') return 'OpenAI';
  return 'Anbieter offen';
}

const featureLabel = computed(() => {
  if (!status.value) return 'Wird geladen …';
  const { explain, assess } = status.value.features;
  if (explain && assess) return 'Erklären · Bewerten';
  if (explain) return 'Erklären';
  if (assess) return 'Bewerten';
  return 'Nicht freigeschaltet';
});

const credentialSummary = computed(() => {
  if (!configured.value) return 'Nicht eingerichtet';
  const route = status.value?.byo;
  const parts = [providerLabel(route?.provider)];
  if (route?.model) parts.push(route.model);
  if (route?.last4) parts.push(`•••• ${route.last4}`);
  return parts.join(' · ');
});

const preferenceSummary = computed(() => {
  const parts = [language.value.trim() || 'Standardsprache'];
  if (customInstructions.value.trim()) parts.push('eigene Hinweise');
  return parts.join(' · ');
});

const privacyRecipient = computed(() => {
  const route = ai.mode === 'pool' ? status.value?.pool : status.value?.byo;
  const label = providerLabel(route?.provider);
  return label === 'Anbieter offen' ? 'den gewählten KI-Anbieter' : label;
});

const poolQuotaLabel = computed(() => {
  const remaining = pool.value?.remaining;
  if (remaining?.tokens !== undefined) {
    return `${remaining.tokens.toLocaleString('de-AT')} Token`;
  }
  if (remaining?.costCents !== undefined) {
    return (remaining.costCents / 100).toLocaleString('de-AT', {
      style: 'currency',
      currency: 'EUR',
    });
  }
  return 'Verfügbar';
});

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function selectMode(next: 'pool' | 'byo'): void {
  credentialSaved.value = false;
  confirmingRemoval.value = false;
  ai.setMode(next);
}

function toggleCredentialEditor(): void {
  if (showCredentialEditor.value) {
    credentialEditorOpen.value = false;
    credentialEditorDismissed.value = true;
    apiKey.value = '';
  } else {
    credentialEditorOpen.value = true;
    credentialEditorDismissed.value = false;
    provider.value = status.value?.byo.provider === 'gemini' ? 'gemini' : 'openai';
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
  if (!apiKey.value.trim() || savingCredential.value) return;
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
    credentialError.value = messageOf(error, 'Der Schlüssel konnte nicht gespeichert werden.');
  } finally {
    savingCredential.value = false;
  }
}

async function removeCredential(): Promise<void> {
  if (savingCredential.value) return;
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
    credentialError.value = messageOf(error, 'Der Schlüssel konnte nicht entfernt werden.');
  } finally {
    savingCredential.value = false;
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
    await app.updateConfig({
      aiLanguage: language.value.trim().slice(0, 80),
      aiCustomInstructions: customInstructions.value.trim().slice(0, 600),
    });
    preferencesSaved.value = true;
  } catch (error) {
    preferencesError.value = messageOf(error, 'Der Antwortstil konnte nicht gespeichert werden.');
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
    maintenanceError.value = messageOf(error, 'Die gespeicherten Antworten konnten nicht gelöscht werden.');
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div v-if="ai.available" class="ai-settings settings__section">
    <SettingsCard title="KI-Erklärungen">
      <template #action>
        <span role="status" aria-live="polite">
          <QChip :tone="readiness.tone">
            <Sparkles :size="14" aria-hidden="true" />
            {{ readiness.label }}
          </QChip>
        </span>
      </template>

      <QNotice v-if="ai.statusError" class="ai-settings__notice" tone="error">
        KI-Status konnte nicht geladen werden: {{ ai.statusError }}
        <template #action>
          <QButton variant="secondary" :disabled="refreshingStatus" @click="retryStatus">
            {{ refreshingStatus ? 'Wird geladen …' : 'Erneut laden' }}
          </QButton>
        </template>
      </QNotice>

      <SettingsRow v-else-if="!status" label="Status">
        <span class="ai-settings__value" role="status" aria-live="polite">Wird geladen …</span>
      </SettingsRow>

      <template v-else>
        <SettingsRow label="Funktionen">
          <span class="ai-settings__value">
            <Sparkles :size="16" aria-hidden="true" />
            {{ featureLabel }}
          </span>
        </SettingsRow>

        <SettingsRow v-if="showSourceChooser" label="Quelle">
          <template #default="{ labelId }">
            <div class="ai-settings__segments" role="radiogroup" :aria-labelledby="labelId">
              <label
                class="ai-settings__segment"
                :class="{ 'ai-settings__segment--on': ai.mode === 'byo' }"
              >
                <input
                  class="ai-settings__choice-input"
                  type="radio"
                  name="ai-source"
                  value="byo"
                  :checked="ai.mode === 'byo'"
                  @change="selectMode('byo')"
                />
                <span>Eigener Schlüssel</span>
              </label>
              <label
                class="ai-settings__segment"
                :class="{ 'ai-settings__segment--on': ai.mode === 'pool' }"
              >
                <input
                  class="ai-settings__choice-input"
                  type="radio"
                  name="ai-source"
                  value="pool"
                  :checked="ai.mode === 'pool'"
                  @change="selectMode('pool')"
                />
                <span>Server</span>
              </label>
            </div>
          </template>
        </SettingsRow>

        <QNotice v-if="sourceUnavailable" class="ai-settings__notice">
          Das Server-Kontingent ist derzeit nicht verfügbar.
          <template #action>
            <QButton variant="secondary" @click="selectMode('byo')">
              Eigenen Schlüssel verwenden
            </QButton>
          </template>
        </QNotice>

        <SettingsRow v-if="pool?.eligible" label="Kontingent">
          <span class="ai-settings__value" role="status">{{ poolQuotaLabel }}</span>
        </SettingsRow>

        <SettingsRow v-if="ai.byoOffered || configured" label="API-Schlüssel">
          <template #description>{{ credentialSummary }}</template>
          <template v-if="configured" #status>
            <span class="ai-settings__secure">
              <ShieldCheck :size="14" aria-hidden="true" />
              {{ ai.byoOffered ? 'Verschlüsselt gespeichert' : 'Gespeichert · Zugriff nicht freigeschaltet' }}
            </span>
          </template>
          <div
            v-if="!ai.byoOffered && configured && confirmingRemoval"
            class="ai-settings__confirm"
            role="group"
            aria-label="Schlüssel wirklich entfernen"
          >
            <span>Schlüssel entfernen?</span>
            <QButton variant="ghost" :disabled="savingCredential" @click="confirmingRemoval = false">
              Abbrechen
            </QButton>
            <QButton variant="danger" :disabled="savingCredential" @click="removeCredential">
              {{ savingCredential ? 'Wird entfernt …' : 'Entfernen' }}
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
              Entfernen
            </span>
          </QButton>
          <QButton
            v-else
            variant="secondary"
            :aria-expanded="showCredentialEditor"
            aria-controls="ai-credential-editor"
            @click="toggleCredentialEditor"
          >
            <span class="ai-settings__button-content">
              <KeyRound :size="16" aria-hidden="true" />
              {{ showCredentialEditor ? 'Schließen' : configured ? 'Ändern' : 'Einrichten' }}
            </span>
          </QButton>
        </SettingsRow>

        <form
          v-if="showCredentialEditor"
          id="ai-credential-editor"
          class="ai-settings__editor"
          aria-label="Eigenen KI-Schlüssel einrichten"
          @submit.prevent="saveCredential"
        >
          <SettingsRow label="Anbieter">
            <template #default="{ labelId }">
              <select v-model="provider" class="ai-settings__input" :aria-labelledby="labelId">
                <option v-for="item in PROVIDERS" :key="item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </template>
          </SettingsRow>

          <SettingsRow :label="configured ? 'Neuer API-Schlüssel' : 'API-Schlüssel'">
            <template #default="{ labelId }">
              <input
                id="ai-key"
                v-model="apiKey"
                type="password"
                class="ai-settings__input"
                maxlength="512"
                autocomplete="off"
                spellcheck="false"
                placeholder="API-Schlüssel"
                :aria-labelledby="labelId"
                @input="credentialSaved = false"
              />
            </template>
          </SettingsRow>

          <SettingsRow label="Modell (optional)">
            <template #default="{ labelId }">
              <input
                id="ai-model"
                v-model="model"
                type="text"
                maxlength="200"
                class="ai-settings__input"
                spellcheck="false"
                placeholder="Standardmodell"
                :aria-labelledby="labelId"
              />
            </template>
          </SettingsRow>

          <QNotice v-if="credentialError" class="ai-settings__notice" tone="error">
            {{ credentialError }}
          </QNotice>

          <div class="ai-settings__editor-actions">
            <span v-if="credentialSaved" class="ai-settings__saved" role="status">
              Schlüssel gespeichert.
            </span>

            <div
              v-if="confirmingRemoval"
              class="ai-settings__confirm"
              role="group"
              aria-label="Schlüssel wirklich entfernen"
            >
              <span>Schlüssel entfernen?</span>
              <QButton variant="ghost" :disabled="savingCredential" @click="confirmingRemoval = false">
                Abbrechen
              </QButton>
              <QButton variant="danger" :disabled="savingCredential" @click="removeCredential">
                {{ savingCredential ? 'Wird entfernt …' : 'Entfernen' }}
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
                  Entfernen
                </span>
              </QButton>
              <QButton type="submit" :disabled="!apiKey.trim() || savingCredential">
                {{ savingCredential ? 'Wird gespeichert …' : 'Speichern' }}
              </QButton>
            </template>
          </div>
        </form>

        <SettingsRow label="Antwortstil">
          <template #description>{{ preferenceSummary }}</template>
          <QButton
            variant="secondary"
            :aria-expanded="preferencesOpen"
            aria-controls="ai-preferences-editor"
            @click="togglePreferences"
          >
            <span class="ai-settings__button-content">
              <Languages :size="16" aria-hidden="true" />
              {{ preferencesOpen ? 'Schließen' : 'Bearbeiten' }}
            </span>
          </QButton>
        </SettingsRow>

        <form
          v-if="preferencesOpen"
          id="ai-preferences-editor"
          class="ai-settings__editor"
          aria-label="Antwortstil der KI"
          @submit.prevent="savePreferences"
        >
          <SettingsRow label="Sprache">
            <template #default="{ labelId }">
              <input
                id="ai-language"
                v-model="language"
                type="text"
                maxlength="80"
                class="ai-settings__input"
                placeholder="Deutsch"
                :aria-labelledby="labelId"
                @input="markPreferencesDirty"
              />
            </template>
          </SettingsRow>
          <SettingsRow label="Hinweise (optional)" layout="stacked">
            <template #default="{ labelId }">
              <textarea
                id="ai-instructions"
                v-model="customInstructions"
                maxlength="600"
                rows="3"
                class="ai-settings__input ai-settings__textarea"
                placeholder="Kurz und mit einem Beispiel erklären."
                :aria-labelledby="labelId"
                aria-describedby="ai-instructions-count"
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
              Antwortstil gespeichert.
            </span>
            <QButton type="submit" :disabled="savingPreferences">
              {{ savingPreferences ? 'Wird gespeichert …' : 'Speichern' }}
            </QButton>
          </div>
        </form>

        <SettingsRow label="Datenschutz" description="Nur auf deinen Klick">
          <QButton
            variant="secondary"
            :aria-expanded="privacyOpen"
            aria-controls="ai-privacy-details"
            @click="privacyOpen = !privacyOpen"
          >
            <span class="ai-settings__button-content">
              <ShieldCheck :size="16" aria-hidden="true" />
              {{ privacyOpen ? 'Schließen' : 'Details' }}
            </span>
          </QButton>
        </SettingsRow>

        <div v-if="privacyOpen" id="ai-privacy-details" class="ai-settings__privacy">
          <p>
            <strong>Übertragen an {{ privacyRecipient }}:</strong>
            Aufgabe, Musterlösung und deine Antwort.
          </p>
          <p><strong>Nicht übertragen:</strong> Konto, Lernfortschritt und Statistiken.</p>
        </div>

        <SettingsRow label="KI-Cache" description="Antworten auf diesem Gerät">
          <template v-if="cacheCleared" #status>
            <span class="ai-settings__saved" role="status">Geleert.</span>
          </template>
          <QButton variant="secondary" :disabled="clearing" @click="clearCache">
            {{ clearing ? 'Wird geleert …' : 'Leeren' }}
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

.ai-settings__notice {
  margin: 0 20px 16px;
}

.ai-settings__value,
.ai-settings__secure,
.ai-settings__button-content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ai-settings__value {
  color: var(--q-ink-2);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.ai-settings__secure,
.ai-settings__saved {
  color: var(--q-ok-ink);
  font-size: 11.5px;
  font-weight: 700;
}

.ai-settings__segments {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  min-height: var(--q-control-height);
  overflow: hidden;
  border: 1px solid var(--q-border-2);
  border-radius: 9px;
  background: var(--q-card);
}

.ai-settings__segment {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--q-control-height);
  box-sizing: border-box;
  padding: 8px 16px;
  background: transparent;
  color: var(--q-mut-2);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.35;
  text-align: center;
}

.ai-settings__segment + .ai-settings__segment {
  border-left: 1px solid var(--q-border-2);
}

.ai-settings__segment--on {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}

.ai-settings__segment:focus-within,
.ai-settings__input:focus-visible {
  position: relative;
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
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

.ai-settings__editor {
  border-top: 1px solid var(--q-border-soft);
  border-bottom: 1px solid var(--q-border-soft);
  background: var(--q-panel);
}

.ai-settings__editor :deep(.q-settings-row) {
  padding-top: 12px;
  padding-bottom: 12px;
}

.ai-settings__input {
  width: min(360px, 100%);
  min-height: var(--q-control-height);
  box-sizing: border-box;
  padding: 0 12px;
  border: 1px solid var(--q-border-2);
  border-radius: 9px;
  background: var(--q-card);
  color: var(--q-ink);
  font-family: inherit;
  font-size: 14px;
  font-weight: 400;
}

.ai-settings__input::placeholder {
  color: var(--q-hint);
}

.ai-settings__textarea {
  width: 100%;
  min-height: 88px;
  padding-top: 10px;
  padding-bottom: 10px;
  line-height: 1.5;
  resize: vertical;
}

.ai-settings__count {
  display: block;
  margin-top: 4px;
  color: var(--q-faint);
  font: 500 11px ui-monospace, Menlo, monospace;
  text-align: right;
}

.ai-settings__editor-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-height: var(--q-control-height);
  padding: 12px 20px 16px;
  flex-wrap: wrap;
}

.ai-settings__saved {
  margin-right: auto;
}

.ai-settings__confirm {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  color: var(--q-err-ink);
  font-size: 12px;
  font-weight: 700;
  flex-wrap: wrap;
}

.ai-settings__privacy {
  padding: 12px 20px;
  border-top: 1px solid var(--q-border-soft);
  border-bottom: 1px solid var(--q-border-soft);
  background: var(--q-panel);
  color: var(--q-mut);
  font-size: 12px;
  line-height: 1.55;
}

.ai-settings__privacy p {
  margin: 0;
}

.ai-settings__privacy p + p {
  margin-top: 4px;
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
  .ai-settings__notice {
    margin-right: 16px;
    margin-left: 16px;
  }

  .ai-settings__value {
    white-space: normal;
  }

  .ai-settings__segments,
  .ai-settings__input {
    width: 100%;
  }

  .ai-settings__editor-actions,
  .ai-settings__confirm {
    align-items: stretch;
    flex-direction: column;
  }

  .ai-settings__saved {
    margin-right: 0;
  }
}
</style>
