<script setup lang="ts">
/**
 * AI settings: which key pays, and informed consent before anything leaves
 * the device.
 *
 * The disclosure is not decoration. Answers go to a third-party provider, the
 * users are Austrian Matura candidates and therefore in the EU, so what is
 * sent and to whom has to be stated plainly and be switchable off — before
 * the first request, not after.
 *
 * The whole section is absent when the server has no AI at all.
 */
import { computed, ref } from 'vue';
import { QButton, QNotice } from '@qed2/ui';
import { useAiStore } from '../../stores/ai.js';
import { useAppStore } from '../../stores/app.js';

const ai = useAiStore();
const app = useAppStore();

/**
 * A hint is for what OUR side supports, not for what a vendor currently gives
 * away — free tiers change without telling us, and a promise we cannot keep
 * belongs in nobody's settings page.
 */
const PROVIDERS: { id: 'openai' | 'gemini'; label: string; hint?: string }[] = [
  { id: 'openai', label: 'OpenAI / ChatGPT' },
  { id: 'gemini', label: 'Google Gemini' },
];

const provider = ref<'openai' | 'gemini'>('openai');
const apiKey = ref('');
const model = ref('');
const saving = ref(false);
const error = ref<string | null>(null);
const saved = ref(false);

const status = computed(() => ai.status);
const configured = computed(() => status.value?.byo.configured === true);
const pool = computed(() => status.value?.pool);

async function save(): Promise<void> {
  if (!apiKey.value.trim() || saving.value) return;
  saving.value = true;
  error.value = null;
  saved.value = false;
  try {
    await ai.saveCredential({
      provider: provider.value,
      apiKey: apiKey.value.trim(),
      ...(model.value.trim() ? { model: model.value.trim() } : {}),
    });
    // Clear it from the form immediately — it is stored server-side now, and
    // leaving it in a DOM input is one screenshot away from a leak.
    apiKey.value = '';
    saved.value = true;
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? 'Konnte nicht gespeichert werden.';
  } finally {
    saving.value = false;
  }
}

const clearing = ref(false);
const language = ref(app.config.aiLanguage ?? '');
const customInstructions = ref(app.config.aiCustomInstructions ?? '');
const savingPreferences = ref(false);
const preferencesSaved = ref(false);

async function savePreferences(): Promise<void> {
  if (savingPreferences.value) return;
  savingPreferences.value = true;
  preferencesSaved.value = false;
  try {
    await app.updateConfig({
      aiLanguage: language.value.trim().slice(0, 80),
      aiCustomInstructions: customInstructions.value.trim().slice(0, 600),
    });
    preferencesSaved.value = true;
  } finally {
    savingPreferences.value = false;
  }
}

async function clearCache(): Promise<void> {
  clearing.value = true;
  try {
    await ai.clearCache();
  } finally {
    clearing.value = false;
  }
}

async function remove(): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    await ai.deleteCredential();
    saved.value = false;
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? 'Konnte nicht gelöscht werden.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section v-if="ai.available" class="settings__section">
    <div class="settings__row">
      <div>
        <div class="settings__row-title">KI-Erklärungen</div>
        <div class="settings__row-sub">Warum eine Antwort falsch ist — auf Wunsch, nie automatisch</div>
      </div>
    </div>

      <!-- The compact summary keeps the essential privacy fact visible; the
           complete disclosure remains one tap away before any request. -->
      <details class="ai-set__details ai-set__disclosure">
        <summary>Datenschutz · Aufgabe und Antwort werden übertragen</summary>
        <ul class="ai-set__disclosure-list">
          <li>Die Aufgabenstellung, die offizielle Lösung und <b>deine Antwort</b></li>
          <li>An den Anbieter, dessen Schlüssel gerade verwendet wird</li>
          <li><b>Nicht</b> übertragen: Benutzername, Konto, Lernfortschritt, Statistiken</li>
        </ul>
        <p class="ai-set__disclosure-foot">
          Ohne hinterlegten Schlüssel und ohne Kontingent wird nichts gesendet.
        </p>
      </details>

      <!-- Pool allowance, when the account has one. -->
      <div v-if="pool?.eligible" class="ai-set__pool">
        <span class="ai-set__pool-title">Kontingent verfügbar</span>
        <span v-if="pool.remaining?.tokens !== undefined" class="ai-set__pool-value">
          noch {{ pool.remaining.tokens.toLocaleString('de-AT') }} Token
        </span>
        <span v-else class="ai-set__pool-value">unbegrenzt</span>
      </div>

      <!--
        One exclusive choice. The pool option is disabled — not hidden — when
        the server has not granted it, so the user can see that it exists and
        why it is unavailable, instead of wondering what they are missing.
      -->
      <div class="ai-set__field">
        <span class="ai-set__label">Welche KI wird verwendet?</span>
        <div class="ai-set__modes" role="radiogroup" aria-label="KI-Quelle">
          <button
            type="button"
            class="ai-set__mode"
            :class="{ 'ai-set__mode--on': ai.mode === 'pool' }"
            role="radio"
            :aria-checked="ai.mode === 'pool'"
            :disabled="!ai.poolOffered"
            @click="ai.setMode('pool')"
          >
            <span class="ai-set__mode-title">
              <span>Vom Server bereitgestellt</span>
              <span v-if="ai.mode === 'pool'" class="ai-set__selected"><span aria-hidden="true">✓</span> Ausgewählt</span>
            </span>
            <span class="ai-set__mode-hint">
              {{ !ai.poolAllowed ? 'Für dieses Konto nicht freigeschaltet' : ai.poolOffered ? 'Kein eigener Schlüssel nötig' : 'Kontingent derzeit nicht verfügbar' }}
            </span>
          </button>
          <button
            type="button"
            class="ai-set__mode"
            :class="{ 'ai-set__mode--on': ai.mode === 'byo' }"
            role="radio"
            :aria-checked="ai.mode === 'byo'"
            :disabled="!ai.byoOffered"
            @click="ai.setMode('byo')"
          >
            <span class="ai-set__mode-title">
              <span>Eigener Schlüssel</span>
              <span v-if="ai.mode === 'byo'" class="ai-set__selected"><span aria-hidden="true">✓</span> Ausgewählt</span>
            </span>
            <span class="ai-set__mode-hint">
              {{ !ai.byoOffered ? 'Für dieses Konto nicht freigeschaltet' : configured ? `${status?.byo.provider === 'gemini' ? 'Gemini' : 'OpenAI'} · ···${status?.byo.last4}` : 'Noch keiner hinterlegt' }}
            </span>
          </button>
        </div>
      </div>

      <div v-if="configured && !ai.byoOffered" class="ai-set__current">
        <div class="ai-set__current-main">
          <span class="ai-set__current-label">Gespeichert, derzeit nicht verwendet</span>
          <span class="ai-set__current-value">
            {{ status?.byo.provider === 'gemini' ? 'Google Gemini' : 'OpenAI' }}
            <template v-if="status?.byo.model"> · {{ status.byo.model }}</template>
            · ···{{ status?.byo.last4 }}
          </span>
        </div>
        <QButton variant="ghost" :disabled="saving" @click="remove">Entfernen</QButton>
      </div>

      <!-- The key form belongs to exactly one of the two modes. -->
      <template v-if="ai.mode === 'byo'">
        <div v-if="configured" class="ai-set__current">
          <div class="ai-set__current-main">
            <span class="ai-set__current-label">Hinterlegt</span>
            <span class="ai-set__current-value">
              {{ status?.byo.provider === 'gemini' ? 'Google Gemini' : 'OpenAI' }}
              <template v-if="status?.byo.model"> · {{ status.byo.model }}</template>
              · ···{{ status?.byo.last4 }}
            </span>
          </div>
          <QButton variant="ghost" :disabled="saving" @click="remove">Entfernen</QButton>
        </div>

        <details class="ai-set__details ai-set__key-details" :open="!configured">
          <summary>{{ configured ? 'Schlüssel ersetzen' : 'Eigenen Schlüssel einrichten' }}</summary>
          <form class="ai-set__form" @submit.prevent="save">
          <div class="ai-set__field">
            <span class="ai-set__label">Anbieter</span>
            <div class="ai-set__providers" role="radiogroup" aria-label="Anbieter">
              <button
                v-for="p in PROVIDERS"
                :key="p.id"
                type="button"
                class="ai-set__provider"
                :class="{ 'ai-set__provider--on': provider === p.id }"
                role="radio"
                :aria-checked="provider === p.id"
                @click="provider = p.id"
              >
                <span class="ai-set__provider-label">
                  <span>{{ p.label }}</span>
                  <span v-if="provider === p.id" class="ai-set__selected"><span aria-hidden="true">✓</span> Ausgewählt</span>
                </span>
                <span v-if="p.hint" class="ai-set__provider-hint">{{ p.hint }}</span>
              </button>
            </div>
          </div>

          <div class="ai-set__field">
            <label class="ai-set__label" for="ai-key">
              {{ configured ? 'Schlüssel ersetzen' : 'API-Schlüssel' }}
            </label>
            <input id="ai-key" v-model="apiKey" type="password" class="ai-set__input"
                   maxlength="512" autocomplete="off" spellcheck="false" placeholder="sk-…" />
            <p class="ai-set__hint">Wird verschlüsselt gespeichert und nie wieder angezeigt — auch nicht dir.</p>
          </div>

          <div class="ai-set__field">
            <label class="ai-set__label" for="ai-model">Modell <span class="ai-set__opt">optional</span></label>
            <input id="ai-model" v-model="model" type="text" maxlength="200" class="ai-set__input" spellcheck="false" placeholder="gpt-5-mini" />
          </div>

          <div class="ai-set__actions">
            <QButton type="submit" :disabled="!apiKey.trim() || saving">
              {{ saving ? 'Speichern …' : 'Speichern' }}
            </QButton>
          </div>
          </form>
        </details>
      </template>

      <details class="ai-set__details ai-set__preferences">
        <summary>Antwortstil</summary>
        <form class="ai-set__form" @submit.prevent="savePreferences">
          <div class="ai-set__field">
            <label class="ai-set__label" for="ai-language">Antwortsprache</label>
            <input
              id="ai-language"
              v-model="language"
              type="text"
              maxlength="80"
              class="ai-set__input"
              placeholder="Deutsch"
            />
            <p class="ai-set__hint">Frei formulierbar, z. B. „Kroatisch, Fachbegriffe auf Deutsch“.</p>
          </div>
          <div class="ai-set__field">
            <label class="ai-set__label" for="ai-instructions">Eigene Hinweise <span class="ai-set__opt">optional</span></label>
            <textarea
              id="ai-instructions"
              v-model="customInstructions"
              maxlength="600"
              rows="3"
              class="ai-set__input ai-set__textarea"
              placeholder="Kurz und mit einem Beispiel erklären."
            />
            <p class="ai-set__hint">Gilt für Erklärungen und Vorschläge; die Bewertungsregeln haben immer Vorrang.</p>
          </div>
          <div class="ai-set__actions">
            <QButton type="submit" :disabled="savingPreferences">
              {{ savingPreferences ? 'Speichern …' : 'Speichern' }}
            </QButton>
            <span v-if="preferencesSaved" class="ai-set__saved" role="status">Gespeichert.</span>
          </div>
        </form>
      </details>

      <details class="ai-set__details ai-set__maintenance">
        <summary>Daten &amp; Speicher</summary>
        <div class="ai-set__maintenance-row">
          <div>
            <span class="ai-set__label">Gespeicherte KI-Antworten</span>
            <p class="ai-set__hint">Lokalen Zwischenspeicher für Erklärungen leeren.</p>
          </div>
          <QButton variant="ghost" :disabled="clearing" @click="clearCache">
            {{ clearing ? 'Wird gelöscht …' : 'Leeren' }}
          </QButton>
        </div>
      </details>

      <QNotice v-if="error" tone="error">{{ error }}</QNotice>
      <p v-else-if="saved" class="ai-set__saved" role="status">Schlüssel gespeichert.</p>
  </section>
</template>

<style scoped>
/*
 * Layout.
 *
 * Phone first: everything stacks. From 560px up the paired fields sit side by
 * side, because on a laptop a column of full-width inputs reads as a form that
 * has not been thought about — and this section is long enough already.
 */
.ai-set__modes {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.ai-set__mode {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-height: 56px;
  padding: 11px 14px;
  border: 1px solid var(--q-border-2);
  border-radius: 11px;
  background: var(--q-card);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: border-color var(--q-transition-fast), background var(--q-transition-fast);
}
.ai-set__mode--on {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
/* Disabled, not hidden: the user should see the option exists and why it is
 * out of reach, rather than wonder what they are missing. */
.ai-set__mode:disabled {
  cursor: default;
  opacity: 0.5;
}
.ai-set__mode:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.ai-set__mode-title {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--q-ink);
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ai-set__mode-hint {
  font-size: 11.5px;
  color: var(--q-faint);
}

.ai-set__row2 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

@media (min-width: 560px) {
  .ai-set__modes,
  .ai-set__row2 {
    grid-template-columns: 1fr 1fr;
  }
}

.ai-set__disclosure {
  background: var(--q-panel);
}
.ai-set__disclosure-list {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--q-mut);
}
.ai-set__disclosure-foot {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--q-faint);
}

.ai-set__pool {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 13px;
  border: 1px solid var(--q-ok-border);
  background: var(--q-ok-bg);
  border-radius: 9px;
  margin-bottom: 14px;
}
.ai-set__pool-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--q-ok-ink);
}
.ai-set__pool-value {
  margin-left: auto;
  font: 700 12px ui-monospace, Menlo, monospace;
  color: var(--q-ok-ink);
}

.ai-set__current {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
  border: 1px solid var(--q-border-2);
  border-radius: 9px;
  margin-bottom: 14px;
}
.ai-set__current-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ai-set__current-label {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.ai-set__current-value {
  font-size: 13px;
  color: var(--q-ink);
  overflow-wrap: anywhere;
}

.ai-set__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ai-set__key-details .ai-set__form {
  margin-top: 14px;
}
.ai-set__preferences .ai-set__form {
  margin-top: 14px;
}
.ai-set__details {
  padding: 11px 13px;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: var(--q-card);
}
.ai-set__details > summary {
  cursor: pointer;
  color: var(--q-ink);
  font-size: 12.5px;
  font-weight: 700;
}
.ai-set__details > summary:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 3px;
  border-radius: 4px;
}
.ai-set__maintenance[open] > summary {
  margin-bottom: 4px;
}
.ai-set__maintenance-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 12px;
}
.ai-set__maintenance-row + .ai-set__maintenance-row {
  margin-top: 12px;
  border-top: 1px solid var(--q-border-soft);
}
.ai-set__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-set__label {
  font-size: 12px;
  font-weight: 700;
  color: var(--q-ink);
}
.ai-set__opt {
  font-weight: 500;
  color: var(--q-faint);
}
.ai-set__input {
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--q-border-2);
  border-radius: 9px;
  background: var(--q-card);
  color: var(--q-ink);
  font: 400 14px 'Public Sans', system-ui, sans-serif;
  width: 100%;
  box-sizing: border-box;
}
.ai-set__input:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.ai-set__textarea {
  resize: vertical;
  min-height: 78px;
  padding-top: 10px;
  padding-bottom: 10px;
  line-height: 1.45;
}
.ai-set__hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--q-faint);
}

.ai-set__providers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}
.ai-set__provider {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  /* Grid rows are equal height; a card with no hint centres its label rather
   * than hanging from the top next to one that has two lines. */
  justify-content: center;
  gap: 2px;
  min-height: 44px;
  padding: 9px 12px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: border-color var(--q-transition-fast), background var(--q-transition-fast);
}
.ai-set__provider--on {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.ai-set__provider:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.ai-set__provider-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--q-ink);
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-set__selected {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--q-accent-strong);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.ai-set__provider-hint {
  font-size: 11px;
  color: var(--q-faint);
}

.ai-set__saved {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-ok-ink);
}

.ai-set__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
}
@media (max-width: 480px) {
  .ai-set__maintenance-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 9px;
  }
}
</style>
