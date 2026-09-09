<script setup lang="ts">
import { useI18n } from '../i18n.js';
const { t } = useI18n();

/**
 * Login/register modal (grading supplement §10): „Anmelden" opens a modal,
 * not a page. The register entry redraws the SAME modal into the invite-code
 * face (no navigation). Controlled by useUiStore; success closes the modal
 * and the user stays where they are. No self-registration — accounts come
 * from invite codes (contract).
 */
import { computed, nextTick, ref, watch } from 'vue';
import { QButton, QIconButton, useModalA11y } from '@qed2/ui';

import { authErrorMessage } from '../platform/auth-errors.js';
import { useAuthStore } from '../stores/auth.js';
import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();
const auth = useAuthStore();
const visible = computed(() => ui.authModalOpen && !auth.transitioning);

const loginUser = ref('');
const loginPass = ref('');
const loginPending = ref(false);
const loginError = ref('');

const inviteCode = ref('');
const inviteUser = ref('');
const invitePass = ref('');
const invitePending = ref(false);
const inviteError = ref('');

async function doLogin(): Promise<void> {
  if (loginPending.value || !loginUser.value || !loginPass.value) return;
  loginPending.value = true;
  loginError.value = '';
  try {
    await auth.login(loginUser.value.trim(), loginPass.value);
    ui.closeAuthModal();
  } catch (e) {
    loginError.value = authErrorMessage(e, 'login');
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
    inviteError.value = authErrorMessage(e, 'invite');
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
  if (visible.value && !loginPending.value && !invitePending.value) ui.closeAuthModal();
}

/* Focus trap + Esc + scroll-lock + focus restore (shared modal baseline). */
const box = ref<HTMLElement | null>(null);
useModalA11y(box, visible, onBackdrop);

watch(
  () => ui.authModalOpen,
  (open) => {
    if (open) {
      loginError.value = '';
      inviteError.value = '';
    } else {
      // A failed transition only hides this instance; an actual dismissal
      // (including successful authentication) releases its credentials.
      loginPass.value = '';
      invitePass.value = '';
    }
  },
  { flush: 'sync' },
);

/* login ↔ register redraws the same card in place — re-focus the first
 * field after the face swap. */
watch(
  () => ui.authModalMode,
  async () => {
    await nextTick();
    if (!visible.value) return;
    box.value?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  },
);
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        v-if="ui.authModalOpen"
        v-show="!auth.transitioning"
      ref="box"
      class="authm q-modal-scrim q-modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-hidden="!visible || undefined"
      :inert="!visible || undefined"
      :aria-label="ui.authModalMode === 'login' ? t('Anmelden') : t('Registrieren')"
      @click.self="onBackdrop"
    >
      <!-- login face -->
      <form v-if="ui.authModalMode === 'login'" class="authm__card" @submit.prevent="doLogin">
        <QIconButton class="authm__close" :aria-label="t('Schließen')" :disabled="loginPending" @click="onBackdrop" />
        <div class="authm__brand">QED<span class="authm__brand-accent">2</span></div>

        <label class="authm__field">
          <span class="authm__label">{{ t('Benutzername') }}</span>
          <input v-model="loginUser" class="authm__input q-input" autocomplete="username" autocapitalize="none" :spellcheck="false" :disabled="loginPending" data-autofocus required />
        </label>
        <label class="authm__field">
          <span class="authm__label">{{ t('Passwort') }}</span>
          <input v-model="loginPass" class="authm__input q-input" type="password" autocomplete="current-password" :disabled="loginPending" required />
        </label>

        <div v-if="loginError" class="authm__error" role="alert">{{ t(loginError) }}</div>

        <QButton type="submit" :disabled="loginPending">
          {{ loginPending ? t('Wird angemeldet …') : t('Anmelden') }}
        </QButton>
        <button type="button" class="authm__switch" :disabled="loginPending" @click="switchMode('register')">
          {{ t('Einladungscode einlösen →') }}
        </button>
      </form>

      <!-- register face (same modal, redrawn in place — supplement §10) -->
      <form v-else class="authm__card" @submit.prevent="doRedeem">
        <QIconButton class="authm__close" :aria-label="t('Schließen')" :disabled="invitePending" @click="onBackdrop" />
        <div class="authm__invite-head">
          <div class="authm__invite-title">{{ t('Einladungscode einlösen') }}</div>
        </div>

        <label class="authm__field">
          <span class="authm__label">{{ t('Einladungscode') }}</span>
          <input
            v-model="inviteCode"
            class="authm__input authm__input--mono q-input"
            placeholder="QED2-XXXX-XXXX"
            autocapitalize="characters"
            :spellcheck="false"
            :disabled="invitePending"
            data-autofocus
            required
          />
        </label>
        <label class="authm__field">
          <span class="authm__label">{{ t('Neuer Benutzername') }}</span>
          <input v-model="inviteUser" class="authm__input q-input" :placeholder="t('z. B. m.huber')" autocomplete="username" autocapitalize="none" :spellcheck="false" :disabled="invitePending" required />
        </label>
        <label class="authm__field">
          <span class="authm__label">{{ t('Passwort festlegen') }}</span>
          <input
            v-model="invitePass"
            class="authm__input q-input"
            type="password"
            :placeholder="t('mind. 8 Zeichen')"
            autocomplete="new-password"
            minlength="8"
            :disabled="invitePending"
            required
          />
        </label>

        <div v-if="inviteError" class="authm__error" role="alert">{{ t(inviteError) }}</div>

        <QButton type="submit" variant="secondary" :disabled="invitePending">
          {{ invitePending ? t('Erstelle Konto …') : t('Konto erstellen') }}
        </QButton>
        <button type="button" class="authm__switch" :disabled="invitePending" @click="switchMode('login')">{{ t('← Anmelden') }}</button>
      </form>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
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
  z-index: 1;
}
.authm__brand {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.02em;
}
.authm__brand-accent {
  color: var(--q-accent);
}
.authm__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.authm__label {
  font-size: var(--q-font-small);
  font-weight: 600;
  color: var(--q-mut);
}
.authm__input--mono {
  font-family: ui-monospace, Menlo, monospace;
  letter-spacing: 0.05em;
}
.authm__error {
  font-size: var(--q-font-ui);
  color: var(--q-err-ink);
  background: var(--q-err-bg);
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  padding: 9px 12px;
}
.authm__switch {
  border: none;
  background: none;
  text-align: center;
  font: 600 var(--q-font-ui) 'Public Sans', system-ui, sans-serif;
  color: var(--q-accent-strong);
  cursor: pointer;
  min-height: var(--q-control-height);
  padding: 8px 0;
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
</style>
