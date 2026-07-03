<script setup lang="ts">
/**
 * Anmelden + Einladungscode (prototype 4b). No self-registration — accounts
 * come from invite codes. Guests can do everything except cloud sync.
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, NetworkError } from '@qed2/core-logic';
import { QButton } from '@qed2/ui';
import { useAuthStore } from '../stores/auth.js';

const router = useRouter();
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
    void router.push('/');
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
    void router.push('/');
  } catch (e) {
    inviteError.value = messageFor(e, 'invite');
  } finally {
    invitePending.value = false;
  }
}

async function doLogout(): Promise<void> {
  await auth.logout();
}
</script>

<template>
  <div class="auth">
    <div v-if="auth.isLoggedIn" class="auth__card auth__card--solo">
      <div class="auth__brand">QED<span class="auth__brand-accent">2</span></div>
      <div class="auth__sub">Angemeldet als <b>{{ auth.username }}</b></div>
      <div class="auth__note">Dein Fortschritt wird geräteübergreifend synchronisiert.</div>
      <QButton variant="danger" @click="doLogout">Abmelden</QButton>
      <div class="auth__hint">Beim Abmelden bleibt der lokale Fortschritt erhalten.</div>
      <RouterLink to="/" class="auth__ghost">Zur Startseite →</RouterLink>
    </div>

    <template v-else>
      <!-- login -->
      <form class="auth__card" @submit.prevent="doLogin">
        <div class="auth__brand">QED<span class="auth__brand-accent">2</span></div>
        <div class="auth__sub">Willkommen zurück</div>

        <label class="auth__field">
          <span class="auth__label">Benutzername</span>
          <input v-model="loginUser" class="auth__input" autocomplete="username" required />
        </label>
        <label class="auth__field">
          <span class="auth__label">Passwort</span>
          <input v-model="loginPass" class="auth__input" type="password" autocomplete="current-password" required />
        </label>

        <div v-if="loginError" class="auth__error" role="alert">{{ loginError }}</div>

        <QButton type="submit" :disabled="loginPending">
          {{ loginPending ? 'Fortschritt wird zusammengeführt …' : 'Anmelden' }}
        </QButton>
        <RouterLink to="/" class="auth__ghost">Ohne Anmeldung fortfahren →</RouterLink>
        <div class="auth__note">Anmeldung dient nur der Synchronisierung. Üben geht auch als Gast.</div>
      </form>

      <!-- invite -->
      <form class="auth__card" @submit.prevent="doRedeem">
        <div class="auth__invite-head">
          <div class="auth__invite-title">Einladungscode einlösen</div>
          <div class="auth__invite-sub">Registrierung nur mit Code</div>
        </div>

        <label class="auth__field">
          <span class="auth__label">Einladungscode</span>
          <input v-model="inviteCode" class="auth__input auth__input--mono" placeholder="QED2-XXXX-XXXX" required />
        </label>
        <label class="auth__field">
          <span class="auth__label">Neuer Benutzername</span>
          <input v-model="inviteUser" class="auth__input" placeholder="z. B. m.huber" autocomplete="username" required />
        </label>
        <label class="auth__field">
          <span class="auth__label">Passwort festlegen</span>
          <input
            v-model="invitePass"
            class="auth__input"
            type="password"
            placeholder="mind. 8 Zeichen"
            autocomplete="new-password"
            required
          />
        </label>

        <div v-if="inviteError" class="auth__error" role="alert">{{ inviteError }}</div>

        <QButton type="submit" variant="secondary" :disabled="invitePending">
          {{ invitePending ? 'Erstelle Konto …' : 'Konto erstellen' }}
        </QButton>
      </form>
    </template>
  </div>
</template>

<style scoped>
.auth {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 20px;
  flex-wrap: wrap;
}
.auth__card {
  width: 340px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 14px;
  box-shadow: var(--q-shadow-panel);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.auth__card--solo {
  align-items: flex-start;
}
.auth__brand {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.02em;
}
.auth__brand-accent {
  color: var(--q-accent);
}
.auth__sub {
  font-size: 13px;
  color: var(--q-mut-2);
  margin-top: -8px;
}
.auth__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.auth__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--q-mut);
}
.auth__input {
  border: 1px solid var(--q-border-3);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 14px;
  background: var(--q-card);
  color: var(--q-ink);
}
.auth__input:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 10px 12px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.auth__input--mono {
  font-family: ui-monospace, Menlo, monospace;
  letter-spacing: 0.05em;
}
.auth__error {
  font-size: 12.5px;
  color: var(--q-err-ink);
  background: var(--q-err-bg);
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  padding: 9px 12px;
}
.auth__ghost {
  text-align: center;
  font-size: 12.5px;
  color: var(--q-accent-strong);
  font-weight: 600;
  text-decoration: none;
  padding-top: 2px;
}
.auth__note,
.auth__hint {
  padding: 11px 13px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--q-mut-2);
}
.auth__hint {
  padding: 0;
  background: none;
  border: none;
}
.auth__invite-head {
  margin: -24px -24px 4px;
  padding: 20px 24px;
  background: var(--q-panel-2);
  border-bottom: 1px solid var(--q-border-soft);
  border-radius: 14px 14px 0 0;
}
.auth__invite-title {
  font-weight: 800;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.auth__invite-sub {
  font-size: 12px;
  color: var(--q-mut-2);
  margin-top: 2px;
}
</style>
