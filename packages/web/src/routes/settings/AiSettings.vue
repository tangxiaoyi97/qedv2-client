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
import { historyLog } from '../../services.js';

const ai = useAiStore();
const app = useAppStore();

const language = ref(app.config.aiLanguage ?? '');
const customInstructions = ref(app.config.aiCustomInstructions ?? '');

function saveLanguage(): void {
  void app.updateConfig({ aiLanguage: language.value.trim() });
}

function saveInstructions(): void {
  void app.updateConfig({ aiCustomInstructions: customInstructions.value.trim() });
}

const PROVIDERS = [
  { id: 'openai' as const, label: 'OpenAI / ChatGPT', hint: 'auch Azure, OpenRouter, DeepSeek, Ollama' },
  { id: 'gemini' as const, label: 'Google Gemini', hint: 'großzügiges Gratis-Kontingent' },
];

const provider = ref<'openai' | 'gemini'>('openai');
const apiKey = ref('');
const model = ref('');
const baseUrl = ref('');
const saving = ref(false);
const error = ref<string | null>(null);
const saved = ref(false);

const status = computed(() => ai.status);
const configured = computed(() => status.value?.byo.configured === true);
const pool = computed(() => status.value?.pool);

/** Only OpenAI-compatible endpoints take a custom base URL. */
const showBaseUrl = computed(() => provider.value === 'openai');

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
      ...(showBaseUrl.value && baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
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

const exporting = ref(false);

async function exportHistory(): Promise<void> {
  exporting.value = true;
  try {
    const entries = await historyLog.exportAll();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qed2-verlauf-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = (e as { message?: string })?.message ?? 'Export fehlgeschlagen.';
  } finally {
    exporting.value = false;
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

      <!-- What leaves the device. Stated before anything is sent. -->
      <div class="ai-set__disclosure">
        <p class="ai-set__disclosure-title">Was dabei übertragen wird</p>
        <ul class="ai-set__disclosure-list">
          <li>Die Aufgabenstellung, die offizielle Lösung und <b>deine Antwort</b></li>
          <li>An den Anbieter, dessen Schlüssel gerade verwendet wird</li>
          <li><b>Nicht</b> übertragen: Benutzername, Konto, Lernfortschritt, Statistiken</li>
        </ul>
        <p class="ai-set__disclosure-foot">
          Ohne hinterlegten Schlüssel und ohne Kontingent wird nichts gesendet.
        </p>
      </div>

      <!-- Pool allowance, when the account has one. -->
      <div v-if="pool?.eligible" class="ai-set__pool">
        <span class="ai-set__pool-title">Kontingent verfügbar</span>
        <span v-if="pool.remaining?.tokens !== undefined" class="ai-set__pool-value">
          noch {{ pool.remaining.tokens.toLocaleString('de-AT') }} Token
        </span>
        <span v-else class="ai-set__pool-value">unbegrenzt</span>
      </div>

      <!-- Only shown when both sources exist; otherwise there is no choice. -->
      <div v-if="ai.canChooseSource" class="ai-set__field">
        <label class="ai-set__label">Welcher Schlüssel wird verwendet?</label>
        <div class="ai-set__providers" role="radiogroup" aria-label="Schlüsselquelle">
          <button
            v-for="opt in [
              { pool: false, label: 'Eigener Schlüssel', hint: 'schont dein Kontingent' },
              { pool: true, label: 'Kontingent', hint: 'schont deinen Schlüssel' },
            ]"
            :key="String(opt.pool)"
            type="button"
            class="ai-set__provider"
            :class="{ 'ai-set__provider--on': ai.preferPool === opt.pool }"
            role="radio"
            :aria-checked="ai.preferPool === opt.pool"
            @click="ai.preferPool = opt.pool"
          >
            <span class="ai-set__provider-label">{{ opt.label }}</span>
            <span class="ai-set__provider-hint">{{ opt.hint }}</span>
          </button>
        </div>
      </div>

      <div v-if="configured" class="ai-set__current">
        <div class="ai-set__current-main">
          <span class="ai-set__current-label">Eigener Schlüssel</span>
          <span class="ai-set__current-value">
            {{ status?.byo.provider === 'gemini' ? 'Google Gemini' : 'OpenAI' }}
            <template v-if="status?.byo.model"> · {{ status.byo.model }}</template>
            · ···{{ status?.byo.last4 }}
          </span>
        </div>
        <QButton variant="ghost" :disabled="saving" @click="remove">Entfernen</QButton>
      </div>

      <form class="ai-set__form" @submit.prevent="save">
        <div class="ai-set__field">
          <label class="ai-set__label" for="ai-provider">Anbieter</label>
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
              <span class="ai-set__provider-label">{{ p.label }}</span>
              <span class="ai-set__provider-hint">{{ p.hint }}</span>
            </button>
          </div>
        </div>

        <div class="ai-set__field">
          <label class="ai-set__label" for="ai-key">
            {{ configured ? 'Schlüssel ersetzen' : 'API-Schlüssel' }}
          </label>
          <input
            id="ai-key"
            v-model="apiKey"
            type="password"
            class="ai-set__input"
            autocomplete="off"
            spellcheck="false"
            placeholder="sk-…"
          />
          <p class="ai-set__hint">
            Wird verschlüsselt gespeichert und nie wieder angezeigt — auch nicht dir.
          </p>
        </div>

        <div class="ai-set__field">
          <label class="ai-set__label" for="ai-model">Modell <span class="ai-set__opt">optional</span></label>
          <input id="ai-model" v-model="model" type="text" class="ai-set__input" spellcheck="false" placeholder="gpt-5-mini" />
        </div>

        <div v-if="showBaseUrl" class="ai-set__field">
          <label class="ai-set__label" for="ai-base">Endpunkt <span class="ai-set__opt">optional</span></label>
          <input id="ai-base" v-model="baseUrl" type="url" class="ai-set__input" spellcheck="false" placeholder="https://api.openai.com/v1" />
          <p class="ai-set__hint">Für Azure, OpenRouter, DeepSeek oder ein lokales Ollama.</p>
        </div>

        <!--
        Prompt preferences. They ride every request rather than being stored:
        two strings do not justify a server table, and the client already owns
        user settings.
      -->
      <div class="ai-set__field">
        <label class="ai-set__label" for="ai-language">
          Antwortsprache <span class="ai-set__opt">optional</span>
        </label>
        <input
          id="ai-language"
          v-model="language"
          type="text"
          class="ai-set__input"
          spellcheck="false"
          maxlength="80"
          placeholder="Deutsch"
          @change="saveLanguage"
        />
        <!-- Free text on purpose: a fixed list would need extending for
             Slovenian or Bosnian, and could not express a mixed request. -->
        <p class="ai-set__hint">
          Schreib die Sprache so, wie du sie willst — auch „Kroatisch, Fachbegriffe auf Deutsch".
          Leer = Deutsch.
        </p>
      </div>

      <div class="ai-set__field">
        <label class="ai-set__label" for="ai-prompt">
          Eigene Anweisungen <span class="ai-set__opt">optional · English</span>
        </label>
        <textarea
          id="ai-prompt"
          v-model="customInstructions"
          class="ai-set__input ai-set__textarea"
          rows="3"
          spellcheck="false"
          maxlength="600"
          placeholder="e.g. Explain like I am a beginner. Always show the intermediate steps."
          @change="saveInstructions"
        ></textarea>
        <p class="ai-set__hint">
          Wird an jede Anfrage angehängt. Die Regeln der App haben Vorrang — Punkte vergibst
          weiterhin nur du selbst. {{ customInstructions.length }}/600
        </p>
      </div>

      <!--
        The answers and self-assessed ticks live only on this device. Handing
        them over has to be a deliberate act, so it is a button and not a sync.
      -->
      <div class="ai-set__field">
        <label class="ai-set__label">Verlauf exportieren <span class="ai-set__opt">optional</span></label>
        <div class="ai-set__actions ai-set__actions--start">
          <QButton variant="secondary" :disabled="exporting" @click="exportHistory">
            {{ exporting ? 'Wird erstellt …' : 'Als JSON speichern' }}
          </QButton>
        </div>
        <p class="ai-set__hint">
          Deine Antworten und Selbstbewertungen von diesem Gerät — für den Vergleich
          „bewertet die KI so wie ich?". Verlässt das Gerät nur, wenn du sie weitergibst.
        </p>
      </div>

      <QNotice v-if="error" tone="error">{{ error }}</QNotice>
        <p v-else-if="saved" class="ai-set__saved" role="status">Schlüssel gespeichert.</p>

        <div class="ai-set__actions">
          <QButton type="submit" :disabled="!apiKey.trim() || saving">
            {{ saving ? 'Speichern …' : 'Speichern' }}
          </QButton>
        </div>
      </form>
  </section>
</template>

<style scoped>
.ai-set__disclosure {
  padding: 12px 14px;
  border: 1px solid var(--q-border-soft);
  background: var(--q-panel);
  border-radius: 10px;
  margin-bottom: 14px;
}
.ai-set__disclosure-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 800;
  color: var(--q-ink);
}
.ai-set__disclosure-list {
  margin: 0;
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
}
.ai-set__provider-hint {
  font-size: 11px;
  color: var(--q-faint);
}

.ai-set__textarea {
  min-height: 80px;
  padding: 10px 12px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}
.ai-set__provider--compact {
  align-items: center;
  min-height: 40px;
  padding: 8px 10px;
}

.ai-set__saved {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-ok-ink);
}

.ai-set__actions {
  display: flex;
  justify-content: flex-end;
}
.ai-set__actions--start {
  justify-content: flex-start;
}
</style>
