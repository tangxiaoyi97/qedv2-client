<script setup lang="ts">
/**
 * Login/register modal (grading supplement §10): „Anmelden" opens a modal,
 * not a page. The register entry redraws the SAME modal into the invite-code
 * face (no navigation). Controlled by useUiStore; success closes the modal
 * and the user stays where they are. No self-registration — accounts come
 * from invite codes (contract).
 */
import { nextTick, ref, watch } from 'vue';
import { ApiError, NetworkError } from '@qed2/core-logic';
import { QButton } from '@qed2/ui';
import { useAuthStore } from '../stores/auth.js';
import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();
const auth = useAuthStore();

const loginUser = ref('');
const loginPass = ref('');
const loginPending = ref(false);
const loginError = ref('');

const inviteCode = ref('');
const inviteUser = ref('');
const invitePass = ref('');
const invitePending = ref(false);
const inviteError = ref('');

const firstField = ref<HTMLInputElement | null>(null);

function messageFor(e: unknown, kind: 'login' | 'invite'): string {
  if (e instanceof NetworkError) return 'Server nicht erreichbar — bitte später versuchen.';
  if (e instanceof ApiError) {
    if (kind === 'login' && e.status === 401) return 'Benutzername oder Passwort falsch.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

async function doLogin(): Promise<void> {
  if (loginPending.value || !loginUser.value || !loginPass.value) return;
  loginPending.value = true;
  loginError.value = '';
  try {
    await auth.login(loginUser.value.trim(), loginPass.value);
    ui.closeAuthModal();
  } catch (e) {
    loginError.value = messageFor(e, 'login');
  } finally {
    loginPending.value = false;
  }
}

async function doRedeem(): Promise<void> {
  if (invitePending.value) return;
  if (invitePass.value.length < 8) {
    inviteError.value = 'Passwort: mindestens 8 Zeichen.';
    return;
  }
  invitePending.value = true;
  inviteError.value = '';
  try {
    await auth.redeem(inviteCode.value.trim(), inviteUser.value.trim(), invitePass.value);
    ui.closeAuthModal();
  } catch (e) {
    inviteError.value = messageFor(e, 'invite');
  } finally {
    invitePending.value = false;
  }
}

function switchMode(mode: 'login' | 'register'): void {
  loginError.value = '';
  inviteError.value = '';
  ui.openAuthModal(mode);
}

function onBackdrop(): void {
  if (!loginPending.value && !invitePending.value) ui.closeAuthModal();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') onBackdrop();
}

watch(
  () => ui.authModalOpen,
  (open) => {
    if (open) {
      loginError.value = '';
      inviteError.value = '';
      document.addEventListener('keydown', onKeydown);
      void nextTick(() => firstField.value?.focus());
    } else {
      document.removeEventListener('keydown', onKeydown);
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        v-if="ui.authModalOpen"
      class="authm"
      role="dialog"
      aria-modal="true"
      :aria-label="ui.authModalMode === 'login' ? 'Anmelden' : 'Registrieren'"
      @click.self="onBackdrop"
    >
      <!-- login face -->
      <form v-if="ui.authModalMode === 'login'" class="authm__card" @submit.prevent="doLogin">
        <button type="button" class="authm__close" aria-label="Schließen" @click="ui.closeAuthModal()">✕</button>
        <div class="authm__brand">QED<span class="authm__brand-accent">2</span></div>
        <div class="authm__sub">Willkommen zurück</div>

        <label class="authm__field">
          <span class="authm__label">Benutzername</span>
          <input ref="firstField" v-model="loginUser" class="authm__input" autocomplete="username" required />
        </label>
        <label class="authm__field">
          <span class="authm__label">Passwort</span>
          <input v-model="loginPass" class="authm__input" type="password" autocomplete="current-password" required />
        </label>

        <div v-if="loginError" class="authm__error" role="alert">{{ loginError }}</div>

        <QButton type="submit" :disabled="loginPending">
          {{ loginPending ? 'Fortschritt wird zusammengeführt …' : 'Anmelden' }}
        </QButton>
        <div class="authm__note">Anmeldung dient nur der Synchronisierung. Üben geht auch als Gast.</div>
        <button type="button" class="authm__switch" @click="switchMode('register')">
          Neu hier? Mit Einladungscode registrieren →
        </button>
      </form>

      <!-- register face (same modal, redrawn in place — supplement §10) -->
      <form v-else class="authm__card" @submit.prevent="doRedeem">
        <button type="button" class="authm__close" aria-label="Schließen" @click="ui.closeAuthModal()">✕</button>
        <div class="authm__invite-head">
          <div class="authm__invite-title">Einladungscode einlösen</div>
          <div class="authm__invite-sub">Registrierung nur mit Code</div>
        </div>

        <label class="authm__field">
          <span class="authm__label">Einladungscode</span>
          <input
            ref="firstField"
            v-model="inviteCode"
            class="authm__input authm__input--mono"
            placeholder="QED2-XXXX-XXXX"
            required
          />
        </label>
        <label class="authm__field">
          <span class="authm__label">Neuer Benutzername</span>
          <input v-model="inviteUser" class="authm__input" placeholder="z. B. m.huber" autocomplete="username" required />
        </label>
        <label class="authm__field">
          <span class="authm__label">Passwort festlegen</span>
          <input
            v-model="invitePass"
            class="authm__input"
            type="password"
            placeholder="mind. 8 Zeichen"
            autocomplete="new-password"
            required
          />
        </label>

        <div v-if="inviteError" class="authm__error" role="alert">{{ inviteError }}</div>

        <QButton type="submit" variant="secondary" :disabled="invitePending">
          {{ invitePending ? 'Erstelle Konto …' : 'Konto erstellen' }}
        </QButton>
        <button type="button" class="authm__switch" @click="switchMode('login')">← Zurück zur Anmeldung</button>
      </form>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.authm {
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
  transition: opacity var(--q-transition-fast);
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
.modal-fade-enter-active .authm__card,
.modal-fade-leave-active .authm__card {
  transition: transform var(--q-transition-fast), opacity var(--q-transition-fast);
}
.modal-fade-enter-from .authm__card,
.modal-fade-leave-to .authm__card {
  opacity: 0;
  transform: scale(0.96) translateY(8px);
}
.authm__card {
  position: relative;
  width: 100%;
  max-width: 380px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.authm__close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--q-mut-2);
  font-size: 13px;
  cursor: pointer;
  display: grid;
  place-items: center;
  font-family: inherit;
  z-index: 1;
}
@media (hover: hover) and (pointer: fine) {
  .authm__close:hover {
    background: var(--q-panel-2);
    color: var(--q-ink);
  }
}
.authm__brand {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.02em;
}
.authm__brand-accent {
  color: var(--q-accent);
}
.authm__sub {
  font-size: 13px;
  color: var(--q-mut-2);
  margin-top: -8px;
}
.authm__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.authm__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--q-mut);
}
.authm__input {
  border: 1px solid var(--q-border-3);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 14px;
  background: var(--q-card);
  color: var(--q-ink);
}
.authm__input:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 10px 12px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.authm__input--mono {
  font-family: ui-monospace, Menlo, monospace;
  letter-spacing: 0.05em;
}
.authm__error {
  font-size: 12.5px;
  color: var(--q-err-ink);
  background: var(--q-err-bg);
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  padding: 9px 12px;
}
.authm__note {
  padding: 11px 13px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--q-mut-2);
}
.authm__switch {
  border: none;
  background: none;
  text-align: center;
  font: 600 12.5px 'Public Sans', system-ui, sans-serif;
  color: var(--q-accent-strong);
  cursor: pointer;
  padding: 4px 0 0;
}
@media (hover: hover) and (pointer: fine) {
  .authm__switch:hover {
    text-decoration: underline;
  }
}
.authm__invite-head {
  margin: -24px -24px 4px;
  padding: 20px 24px;
  background: var(--q-panel-2);
  border-bottom: 1px solid var(--q-border-soft);
  border-radius: 14px 14px 0 0;
}
.authm__invite-title {
  font-weight: 800;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.authm__invite-sub {
  font-size: 12px;
  color: var(--q-mut-2);
  margin-top: 2px;
}
</style>
