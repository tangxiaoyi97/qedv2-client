<script setup lang="ts">
/**
 * Shared Web/PWA/Desktop AI settings.
 *
 * The server decides which sources and features an account may use. This view
 * makes that state legible, keeps every action explicit, and explains what
 * leaves the device before the first request is made.
 */
import { computed, ref } from 'vue';
import { QButton, QChip, QNotice } from '@qed2/ui';
import { useAiStore } from '../../stores/ai.js';
import { useAppStore } from '../../stores/app.js';

const ai = useAiStore();
const app = useAppStore();

const PROVIDERS: { id: 'openai' | 'gemini'; label: string }[] = [
  { id: 'openai', label: 'OpenAI / ChatGPT' },
  { id: 'gemini', label: 'Google Gemini' },
];

const provider = ref<'openai' | 'gemini'>('openai');
const apiKey = ref('');
const model = ref('');
const savingCredential = ref(false);
const credentialError = ref<string | null>(null);
const credentialSaved = ref(false);
const confirmingRemoval = ref(false);

const clearing = ref(false);
const cacheCleared = ref(false);
const maintenanceError = ref<string | null>(null);

const language = ref(app.config.aiLanguage ?? '');
const customInstructions = ref(app.config.aiCustomInstructions ?? '');
const savingPreferences = ref(false);
const preferencesSaved = ref(false);
const preferencesError = ref<string | null>(null);
const refreshingStatus = ref(false);

const status = computed(() => ai.status);
const configured = computed(() => status.value?.byo.configured === true);
const pool = computed(() => status.value?.pool);
const showStoredCredential = computed(
  () => configured.value && (ai.mode === 'byo' || !ai.byoOffered),
);

type ReadinessTone = 'accent' | 'neutral' | 'warn';

interface Readiness {
  label: string;
  detail: string;
  symbol: string;
  tone: ReadinessTone;
}

function providerLabel(value: string | undefined): string {
  if (value === 'gemini') return 'Google Gemini';
  if (value === 'openai') return 'OpenAI';
  return 'Anbieter noch offen';
}

const sourceLabel = computed(() =>
  ai.mode === 'pool' ? 'Vom Server bereitgestellt' : 'Eigener Schlüssel',
);

const providerModelLabel = computed(() => {
  if (!status.value) return 'Wird mit dem Status geladen';
  if (ai.mode === 'byo' && !configured.value) return 'Nach dem Einrichten sichtbar';
  const selected = ai.mode === 'pool' ? status.value.pool : status.value.byo;
  const providerName = providerLabel(selected.provider);
  return selected.model ? `${providerName} · ${selected.model}` : `${providerName} · Standardmodell`;
});

const featureLabel = computed(() => {
  const features = status.value?.features;
  const explain = features?.explain ?? ai.capabilities?.explain;
  const assess = features?.assess ?? ai.capabilities?.assess;
  if (explain && assess) return 'Erklärungen & Bewertungsvorschläge';
  if (explain) return 'Erklärungen';
  if (assess) return 'Bewertungsvorschläge';
  return status.value ? 'Derzeit nicht freigeschaltet' : 'Wird geladen';
});

const readiness = computed<Readiness>(() => {
  if (ai.statusError) {
    return {
      label: 'Status nicht verfügbar',
      detail: 'Verbindung prüfen und den KI-Status erneut laden.',
      symbol: '!',
      tone: 'warn',
    };
  }
  if (!status.value) {
    return {
      label: 'Status wird geladen',
      detail: 'Berechtigungen, Anbieter und Modell werden abgefragt.',
      symbol: '…',
      tone: 'neutral',
    };
  }
  if (!status.value.features.explain) {
    return {
      label: 'Erklärungen deaktiviert',
      detail: 'Der Server stellt für dieses Konto derzeit keine Erklärungen bereit.',
      symbol: '!',
      tone: 'warn',
    };
  }
  if (ai.mode === 'pool') {
    if (!ai.poolAllowed) {
      return {
        label: 'Nicht freigeschaltet',
        detail: 'Das Server-Kontingent ist für dieses Konto nicht freigeschaltet.',
        symbol: '!',
        tone: 'warn',
      };
    }
    if (!ai.poolOffered) {
      return {
        label: 'Kontingent nicht verfügbar',
        detail: 'Eine andere Quelle wählen oder später erneut versuchen.',
        symbol: '!',
        tone: 'warn',
      };
    }
    return {
      label: 'Einsatzbereit',
      detail: 'Das Server-Kontingent kann für manuell angeforderte Erklärungen verwendet werden.',
      symbol: '✓',
      tone: 'accent',
    };
  }
  if (!ai.byoOffered) {
    return {
      label: 'Nicht freigeschaltet',
      detail: 'Eigene Schlüssel sind für dieses Konto nicht freigeschaltet.',
      symbol: '!',
      tone: 'warn',
    };
  }
  if (!configured.value) {
    return {
      label: 'Einrichtung nötig',
      detail: 'Einen API-Schlüssel hinterlegen, bevor eine Erklärung angefordert werden kann.',
      symbol: '!',
      tone: 'warn',
    };
  }
  return {
    label: 'Einsatzbereit',
    detail: 'Der gespeicherte Schlüssel kann für manuell angeforderte Erklärungen verwendet werden.',
    symbol: '✓',
    tone: 'accent',
  };
});

const poolModeHint = computed(() => {
  if (!status.value) return 'Berechtigung wird geladen';
  if (!ai.poolAllowed) return 'Für dieses Konto nicht freigeschaltet';
  if (!ai.poolOffered) return 'Kontingent derzeit nicht verfügbar';
  return 'Kein eigener Schlüssel nötig';
});

const byoModeHint = computed(() => {
  if (!status.value) return 'Berechtigung wird geladen';
  if (!ai.byoOffered) return 'Für dieses Konto nicht freigeschaltet';
  if (!configured.value) return 'Noch kein Schlüssel hinterlegt';
  return `${providerLabel(status.value.byo.provider)} · Schlüssel ···${status.value.byo.last4}`;
});

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function selectMode(next: 'pool' | 'byo'): void {
  credentialSaved.value = false;
  confirmingRemoval.value = false;
  ai.setMode(next);
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
    // A secret must not remain in the DOM after it has reached the server.
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
    credentialSaved.value = false;
    confirmingRemoval.value = false;
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
  <section
    v-if="ai.available"
    class="ai-set settings__section"
    aria-labelledby="ai-settings-title"
  >
    <header class="ai-set__header">
      <div class="ai-set__heading">
        <h2 id="ai-settings-title" class="ai-set__title">KI-Erklärungen</h2>
        <p class="ai-set__subtitle">
          Zusätzliche Hilfe zu einer Antwort — bewusst angefordert, nie automatisch.
        </p>
      </div>
      <span class="ai-set__status" role="status" aria-live="polite">
        <QChip :tone="readiness.tone">
          <span aria-hidden="true">{{ readiness.symbol }}</span>
          {{ readiness.label }}
        </QChip>
      </span>
    </header>

    <p class="ai-set__activation-note">
      <strong>Nur auf deinen Klick.</strong>
      Beim normalen Üben wird keine Aufgabe an einen KI-Anbieter gesendet.
    </p>

    <dl class="ai-set__overview" aria-label="Aktuelle KI-Konfiguration">
      <div>
        <dt>Quelle</dt>
        <dd>{{ sourceLabel }}</dd>
      </div>
      <div>
        <dt>Anbieter &amp; Modell</dt>
        <dd>{{ providerModelLabel }}</dd>
      </div>
      <div>
        <dt>Verfügbare Hilfe</dt>
        <dd>{{ featureLabel }}</dd>
      </div>
    </dl>
    <p class="ai-set__readiness-detail">{{ readiness.detail }}</p>

    <QNotice v-if="ai.statusError" tone="error">
      KI-Status konnte nicht geladen werden: {{ ai.statusError }}
      <template #action>
        <QButton variant="secondary" :disabled="refreshingStatus" @click="retryStatus">
          {{ refreshingStatus ? 'Wird geladen …' : 'Status erneut laden' }}
        </QButton>
      </template>
    </QNotice>

    <div v-else-if="!status" class="ai-set__loading" role="status" aria-live="polite">
      KI-Konfiguration wird geladen …
    </div>

    <div class="ai-set__privacy-lead">
      <strong>Vor jeder Anfrage transparent:</strong>
      Übertragen werden die Aufgabe, die offizielle Lösung und deine eingegebene Antwort.
    </div>
    <details class="ai-set__details ai-set__disclosure">
      <summary>Datenschutz · Aufgabe und Antwort werden übertragen</summary>
      <ul class="ai-set__disclosure-list">
        <li>Die Aufgabenstellung, die offizielle Lösung und <b>deine Antwort</b></li>
        <li>An den Anbieter, dessen Schlüssel gerade verwendet wird</li>
        <li><b>Nicht</b> übertragen: Benutzername, Konto, Lernfortschritt, Statistiken</li>
      </ul>
      <p class="ai-set__disclosure-foot">
        Ohne einsatzbereite Quelle wird nichts gesendet. Bereits geladene Antworten bleiben nur lokal im Cache.
      </p>
    </details>

    <div v-if="pool?.eligible" class="ai-set__pool" role="status">
      <span class="ai-set__pool-title"><span aria-hidden="true">✓</span> Kontingent verfügbar</span>
      <span v-if="pool.remaining?.tokens !== undefined" class="ai-set__pool-value">
        noch {{ pool.remaining.tokens.toLocaleString('de-AT') }} Token
      </span>
      <span v-else class="ai-set__pool-value">ohne angezeigte Grenze</span>
    </div>

    <fieldset class="ai-set__field ai-set__fieldset">
      <legend class="ai-set__label">Quelle wählen</legend>
      <p class="ai-set__hint">Genau eine Quelle bezahlt und verarbeitet eine angeforderte Erklärung.</p>
      <div class="ai-set__modes">
        <label
          class="ai-set__mode"
          :class="{
            'ai-set__mode--on': ai.mode === 'pool',
            'ai-set__mode--disabled': !status || !ai.poolOffered,
          }"
        >
          <input
            class="ai-set__choice-input"
            type="radio"
            name="ai-source"
            value="pool"
            :checked="ai.mode === 'pool'"
            :disabled="!status || !ai.poolOffered"
            aria-describedby="ai-mode-pool-hint"
            @change="selectMode('pool')"
          />
          <span class="ai-set__mode-title">
            <span>Vom Server bereitgestellt</span>
            <span v-if="ai.mode === 'pool'" class="ai-set__selected"><span aria-hidden="true">✓</span> Ausgewählt</span>
          </span>
          <span id="ai-mode-pool-hint" class="ai-set__mode-hint">{{ poolModeHint }}</span>
        </label>

        <label
          class="ai-set__mode"
          :class="{
            'ai-set__mode--on': ai.mode === 'byo',
            'ai-set__mode--disabled': !status || !ai.byoOffered,
          }"
        >
          <input
            class="ai-set__choice-input"
            type="radio"
            name="ai-source"
            value="byo"
            :checked="ai.mode === 'byo'"
            :disabled="!status || !ai.byoOffered"
            aria-describedby="ai-mode-byo-hint"
            @change="selectMode('byo')"
          />
          <span class="ai-set__mode-title">
            <span>Eigener Schlüssel</span>
            <span v-if="ai.mode === 'byo'" class="ai-set__selected"><span aria-hidden="true">✓</span> Ausgewählt</span>
          </span>
          <span id="ai-mode-byo-hint" class="ai-set__mode-hint">{{ byoModeHint }}</span>
        </label>
      </div>
    </fieldset>

    <div v-if="showStoredCredential" class="ai-set__current">
      <div class="ai-set__current-main">
        <span class="ai-set__current-label">Gespeicherter eigener Schlüssel</span>
        <span class="ai-set__current-value">
          {{ providerLabel(status?.byo.provider) }}
          <template v-if="status?.byo.model"> · {{ status.byo.model }}</template>
          · Schlüssel ···{{ status?.byo.last4 }}
        </span>
      </div>
      <QButton
        v-if="!confirmingRemoval"
        variant="danger"
        :disabled="savingCredential"
        @click="confirmingRemoval = true"
      >
        Schlüssel entfernen
      </QButton>
      <div v-else class="ai-set__confirm" role="group" aria-label="Schlüssel wirklich entfernen">
        <span>Wirklich entfernen?</span>
        <QButton variant="danger" :disabled="savingCredential" @click="removeCredential">
          {{ savingCredential ? 'Wird entfernt …' : 'Entfernen' }}
        </QButton>
        <QButton variant="ghost" :disabled="savingCredential" @click="confirmingRemoval = false">
          Abbrechen
        </QButton>
      </div>
    </div>

    <template v-if="ai.mode === 'byo' && ai.byoOffered">
      <details class="ai-set__details ai-set__key-details" :open="!configured">
        <summary>{{ configured ? 'Schlüssel ersetzen' : 'Eigenen Schlüssel einrichten' }}</summary>
        <form class="ai-set__form" aria-label="Eigenen KI-Schlüssel einrichten" @submit.prevent="saveCredential">
          <fieldset class="ai-set__field ai-set__fieldset">
            <legend class="ai-set__label">Anbieter</legend>
            <div class="ai-set__providers">
              <label
                v-for="item in PROVIDERS"
                :key="item.id"
                class="ai-set__provider"
                :class="{ 'ai-set__provider--on': provider === item.id }"
              >
                <input
                  v-model="provider"
                  class="ai-set__choice-input"
                  type="radio"
                  name="ai-provider"
                  :value="item.id"
                />
                <span class="ai-set__provider-label">
                  <span>{{ item.label }}</span>
                  <span v-if="provider === item.id" class="ai-set__selected"><span aria-hidden="true">✓</span> Ausgewählt</span>
                </span>
              </label>
            </div>
          </fieldset>

          <div class="ai-set__field">
            <label class="ai-set__label" for="ai-key">
              {{ configured ? 'Neuer API-Schlüssel' : 'API-Schlüssel' }}
            </label>
            <input
              id="ai-key"
              v-model="apiKey"
              type="password"
              class="ai-set__input"
              maxlength="512"
              autocomplete="off"
              spellcheck="false"
              placeholder="API-Schlüssel einfügen"
              aria-describedby="ai-key-help"
              @input="credentialSaved = false"
            />
            <p id="ai-key-help" class="ai-set__hint">
              Wird verschlüsselt serverseitig gespeichert und danach weder angezeigt noch in diesem Formular behalten.
            </p>
          </div>

          <div class="ai-set__field">
            <label class="ai-set__label" for="ai-model">
              Modell <span class="ai-set__opt">optional</span>
            </label>
            <input
              id="ai-model"
              v-model="model"
              type="text"
              maxlength="200"
              class="ai-set__input"
              spellcheck="false"
              placeholder="Standardmodell des Anbieters"
              aria-describedby="ai-model-help"
            />
            <p id="ai-model-help" class="ai-set__hint">
              Leer lassen, damit der Server das freigegebene Standardmodell verwendet.
            </p>
          </div>

          <QNotice v-if="credentialError" tone="error">{{ credentialError }}</QNotice>
          <div class="ai-set__actions">
            <span v-if="credentialSaved" class="ai-set__saved" role="status">Schlüssel gespeichert.</span>
            <QButton type="submit" :disabled="!apiKey.trim() || savingCredential">
              {{ savingCredential ? 'Wird gespeichert …' : configured ? 'Schlüssel ersetzen' : 'Schlüssel speichern' }}
            </QButton>
          </div>
        </form>
      </details>
    </template>

    <details class="ai-set__details ai-set__preferences">
      <summary>Antwortstil</summary>
      <form class="ai-set__form" aria-label="Antwortstil der KI" @submit.prevent="savePreferences">
        <div class="ai-set__field">
          <label class="ai-set__label" for="ai-language">Antwortsprache</label>
          <input
            id="ai-language"
            v-model="language"
            type="text"
            maxlength="80"
            class="ai-set__input"
            placeholder="Deutsch"
            aria-describedby="ai-language-help"
            @input="markPreferencesDirty"
          />
          <p id="ai-language-help" class="ai-set__hint">
            Frei formulierbar, z. B. „Kroatisch, Fachbegriffe auf Deutsch“.
          </p>
        </div>
        <div class="ai-set__field">
          <label class="ai-set__label" for="ai-instructions">
            Eigene Hinweise <span class="ai-set__opt">optional</span>
          </label>
          <textarea
            id="ai-instructions"
            v-model="customInstructions"
            maxlength="600"
            rows="4"
            class="ai-set__input ai-set__textarea"
            placeholder="Kurz und mit einem Beispiel erklären."
            aria-describedby="ai-instructions-help ai-instructions-count"
            @input="markPreferencesDirty"
          />
          <div class="ai-set__hint-row">
            <p id="ai-instructions-help" class="ai-set__hint">
              Gilt für Erklärungen und Vorschläge; Bewertungsregeln haben immer Vorrang.
            </p>
            <span id="ai-instructions-count" class="ai-set__count">{{ customInstructions.length }}/600</span>
          </div>
        </div>
        <QNotice v-if="preferencesError" tone="error">{{ preferencesError }}</QNotice>
        <div class="ai-set__actions">
          <span v-if="preferencesSaved" class="ai-set__saved" role="status">Antwortstil gespeichert.</span>
          <QButton type="submit" :disabled="savingPreferences">
            {{ savingPreferences ? 'Wird gespeichert …' : 'Antwortstil speichern' }}
          </QButton>
        </div>
      </form>
    </details>

    <details class="ai-set__details ai-set__maintenance">
      <summary>Daten &amp; Speicher</summary>
      <div class="ai-set__maintenance-row">
        <div>
          <span class="ai-set__label">Gespeicherte KI-Antworten</span>
          <p class="ai-set__hint">
            Nur der lokale Zwischenspeicher dieses Geräts wird geleert; Schlüssel und Einstellungen bleiben erhalten.
          </p>
        </div>
        <QButton variant="secondary" :disabled="clearing" @click="clearCache">
          {{ clearing ? 'Wird geleert …' : 'Antworten leeren' }}
        </QButton>
      </div>
      <QNotice v-if="maintenanceError" tone="error">{{ maintenanceError }}</QNotice>
      <p v-else-if="cacheCleared" class="ai-set__saved" role="status">
        Lokale KI-Antworten wurden geleert.
      </p>
    </details>
  </section>
</template>

<style scoped>
.ai-set {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--q-border);
  border-radius: 12px;
  background: var(--q-card);
}

.ai-set__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.ai-set__heading {
  min-width: 0;
}

.ai-set__title,
.ai-set__subtitle,
.ai-set__activation-note,
.ai-set__readiness-detail,
.ai-set__privacy-lead,
.ai-set__hint,
.ai-set__disclosure-foot {
  margin: 0;
}

.ai-set__title {
  color: var(--q-ink);
  font-size: 18px;
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.01em;
}

.ai-set__subtitle {
  margin-top: 4px;
  color: var(--q-mut-2);
  font-size: 12.5px;
  line-height: 1.55;
}

.ai-set__status {
  display: inline-flex;
  flex: none;
}

.ai-set__activation-note,
.ai-set__privacy-lead {
  padding: 11px 13px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
  color: var(--q-mut);
  font-size: 12.5px;
  line-height: 1.55;
}

.ai-set__activation-note strong,
.ai-set__privacy-lead strong {
  color: var(--q-ink);
}

.ai-set__overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.ai-set__overview > div {
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
}

.ai-set__overview dt {
  color: var(--q-faint);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ai-set__overview dd {
  margin: 3px 0 0;
  color: var(--q-ink);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ai-set__readiness-detail,
.ai-set__loading {
  color: var(--q-mut-2);
  font-size: 12px;
  line-height: 1.5;
}

.ai-set__loading {
  padding: 10px 12px;
  border: 1px dashed var(--q-border-2);
  border-radius: 9px;
  background: var(--q-panel);
}

.ai-set__details {
  padding: 0 13px;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: var(--q-card);
  overflow: hidden;
}

.ai-set__details[open] {
  padding-bottom: 13px;
}

.ai-set__details > summary {
  min-height: var(--q-control-height);
  box-sizing: border-box;
  padding: 12px 2px;
  cursor: pointer;
  color: var(--q-ink);
  font-size: 12.5px;
  font-weight: 700;
  line-height: 1.45;
}

.ai-set__details[open] > summary {
  border-bottom: 1px solid var(--q-border-soft);
}

.ai-set__details > summary:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.ai-set__disclosure {
  background: var(--q-panel);
}

.ai-set__disclosure-list {
  margin: 12px 0 0;
  padding-left: 18px;
  color: var(--q-mut);
  font-size: 12.5px;
  line-height: 1.6;
}

.ai-set__disclosure-foot {
  margin-top: 8px;
  color: var(--q-faint);
  font-size: 11.5px;
  line-height: 1.5;
}

.ai-set__pool {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 13px;
  border: 1px solid var(--q-ok-border);
  border-radius: 9px;
  background: var(--q-ok-bg);
}

.ai-set__pool-title {
  color: var(--q-ok-ink);
  font-size: 12.5px;
  font-weight: 700;
}

.ai-set__pool-value {
  margin-left: auto;
  color: var(--q-ok-ink);
  font: 700 12px ui-monospace, Menlo, monospace;
}

.ai-set__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.ai-set__fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.ai-set__label {
  color: var(--q-ink);
  font-size: 12px;
  font-weight: 700;
}

.ai-set__hint {
  color: var(--q-faint);
  font-size: 11.5px;
  line-height: 1.5;
}

.ai-set__modes,
.ai-set__providers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 4px;
}

.ai-set__mode,
.ai-set__provider {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: var(--q-control-height);
  box-sizing: border-box;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 3px;
  padding: 11px 13px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--q-transition-fast),
    background var(--q-transition-fast),
    box-shadow var(--q-transition-fast),
    opacity var(--q-transition-fast);
}

.ai-set__mode {
  min-height: 68px;
}

.ai-set__mode--on,
.ai-set__provider--on {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}

.ai-set__mode--disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.ai-set__mode:focus-within,
.ai-set__provider:focus-within {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .ai-set__mode:not(.ai-set__mode--disabled):hover,
  .ai-set__provider:hover {
    border-color: var(--q-accent);
    background: var(--q-panel);
  }
}

.ai-set__choice-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.ai-set__mode-title,
.ai-set__provider-label {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--q-ink);
  font-size: 13px;
  font-weight: 700;
}

.ai-set__mode-hint {
  color: var(--q-faint);
  font-size: 11.5px;
  line-height: 1.4;
}

.ai-set__selected {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  color: var(--q-accent-strong);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.ai-set__current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 13px;
  border: 1px solid var(--q-border-2);
  border-radius: 9px;
  background: var(--q-panel);
}

.ai-set__current-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.ai-set__current-label {
  color: var(--q-faint);
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.ai-set__current-value {
  color: var(--q-ink);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.ai-set__confirm {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--q-err-ink);
  font-size: 12px;
  font-weight: 700;
}

.ai-set__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
}

.ai-set__input {
  width: 100%;
  min-height: var(--q-control-height);
  box-sizing: border-box;
  padding: 0 12px;
  border: 1px solid var(--q-border-2);
  border-radius: 9px;
  background: var(--q-card);
  color: var(--q-ink);
  font: 400 14px 'Public Sans', system-ui, sans-serif;
}

.ai-set__input::placeholder {
  color: var(--q-hint);
}

.ai-set__input:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}

.ai-set__textarea {
  min-height: 96px;
  padding-top: 10px;
  padding-bottom: 10px;
  line-height: 1.5;
  resize: vertical;
}

.ai-set__opt,
.ai-set__count {
  color: var(--q-faint);
  font-weight: 500;
}

.ai-set__hint-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.ai-set__count {
  flex: none;
  font: 500 11px ui-monospace, Menlo, monospace;
}

.ai-set__maintenance-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 12px;
}

.ai-set__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.ai-set__saved {
  margin: 0;
  color: var(--q-ok-ink);
  font-size: 12.5px;
  font-weight: 700;
}

@media (max-width: 560px) {
  .ai-set {
    padding: 16px;
  }

  .ai-set__header,
  .ai-set__current,
  .ai-set__maintenance-row {
    align-items: stretch;
    flex-direction: column;
  }

  .ai-set__status {
    align-self: flex-start;
  }

  .ai-set__overview,
  .ai-set__modes,
  .ai-set__providers {
    grid-template-columns: minmax(0, 1fr);
  }

  .ai-set__pool {
    align-items: flex-start;
    flex-direction: column;
  }

  .ai-set__pool-value {
    margin-left: 0;
  }

  .ai-set__confirm,
  .ai-set__actions {
    justify-content: flex-start;
  }

  .ai-set__hint-row {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
