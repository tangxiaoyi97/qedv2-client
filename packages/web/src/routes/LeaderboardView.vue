<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ApiError, type LeaderboardDetail, type LeaderboardPeriod, type LeaderboardResponse } from '@qed2/core-logic';
import { QButton } from '@qed2/ui';
import { LogOut, Pencil, Trophy } from 'lucide-vue-next';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useLeaderboardStore } from '../stores/leaderboard.js';
import { useUiStore } from '../stores/ui.js';
import LeaderboardDetailDrawer from './leaderboard/LeaderboardDetailDrawer.vue';
import LeaderboardRow from './leaderboard/LeaderboardRow.vue';

const PAGE_SIZE = 50;

const app = useAppStore();
const auth = useAuthStore();
const leaderboard = useLeaderboardStore();
const ui = useUiStore();

const period = ref<LeaderboardPeriod>('today');
const response = ref<LeaderboardResponse | undefined>();
const loading = ref(false);
const loadingMore = ref(false);
const loadError = ref('');
const nickname = ref('');
const editingNickname = ref(false);
const savingProfile = ref(false);
const profileError = ref('');
const selectedProfileId = ref<string | undefined>();
const selectedDetail = ref<LeaderboardDetail | undefined>();
const detailLoading = ref(false);
const detailError = ref('');
let listRequest = 0;
let detailRequest = 0;

const profile = computed(() => leaderboard.profile);
const isParticipating = computed(() => profile.value?.participating === true);
const periodLabel = computed(() => (period.value === 'today' ? 'heute' : 'diese Woche'));
const canLoadMore = computed(
  () =>
    response.value !== undefined &&
    response.value.items.length < response.value.totalParticipants,
);

function syncNicknameField(): void {
  const current = profile.value;
  if (current?.participating) nickname.value = current.nickname;
  else nickname.value = current?.suggestedNickname || auth.username || '';
}

async function loadList(reset = true): Promise<void> {
  if (!auth.isLoggedIn) return;
  const request = ++listRequest;
  const page = reset ? 1 : (response.value?.page ?? 0) + 1;
  if (reset) loading.value = true;
  else loadingMore.value = true;
  loadError.value = '';
  try {
    const next = await app.serverClient.getLeaderboard({
      period: period.value,
      page,
      pageSize: PAGE_SIZE,
    });
    if (request !== listRequest) return;
    response.value =
      reset || !response.value
        ? next
        : { ...next, items: [...response.value.items, ...next.items] };
  } catch (error) {
    if (request !== listRequest) return;
    loadError.value =
      error instanceof ApiError && error.status === 401
        ? 'Bitte melde dich erneut an.'
        : 'Das Leaderboard konnte nicht geladen werden.';
  } finally {
    if (request === listRequest) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

async function initialize(): Promise<void> {
  if (!auth.isLoggedIn) return;
  // The requested default is useful immediately, even before the profile
  // request returns on a slow connection.
  if (!nickname.value) nickname.value = auth.username ?? '';
  await Promise.all([leaderboard.refreshProfile(), loadList(true)]);
  syncNicknameField();
}

async function selectPeriod(next: LeaderboardPeriod): Promise<void> {
  if (period.value === next) return;
  period.value = next;
  await loadList(true);
}

function friendlyProfileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NICKNAME_TAKEN') return 'Dieser Nickname ist bereits vergeben.';
    if (error.code === 'VALIDATION_FAILED') return 'Der Nickname muss 2–32 sichtbare Zeichen haben.';
  }
  return 'Die Änderung konnte nicht gespeichert werden.';
}

async function saveProfile(): Promise<void> {
  if (savingProfile.value) return;
  savingProfile.value = true;
  profileError.value = '';
  try {
    await leaderboard.saveNickname(nickname.value);
    syncNicknameField();
    editingNickname.value = false;
    await loadList(true);
  } catch (error) {
    profileError.value = friendlyProfileError(error);
  } finally {
    savingProfile.value = false;
  }
}

async function leaveLeaderboard(): Promise<void> {
  if (savingProfile.value) return;
  savingProfile.value = true;
  profileError.value = '';
  try {
    await leaderboard.leave();
    syncNicknameField();
    editingNickname.value = false;
    await loadList(true);
  } catch {
    profileError.value = 'Das Leaderboard konnte nicht verlassen werden.';
  } finally {
    savingProfile.value = false;
  }
}

async function loadDetail(profileId: string): Promise<void> {
  const request = ++detailRequest;
  selectedDetail.value = undefined;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const detail = await app.serverClient.getLeaderboardDetail(profileId);
    if (request === detailRequest) selectedDetail.value = detail;
  } catch {
    if (request === detailRequest) {
      detailError.value = 'Die Details konnten nicht geladen werden.';
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function openDetail(profileId: string): Promise<void> {
  selectedProfileId.value = profileId;
  await loadDetail(profileId);
}

function retryDetail(): void {
  if (selectedProfileId.value) void loadDetail(selectedProfileId.value);
}

function closeDetail(): void {
  detailRequest += 1;
  selectedProfileId.value = undefined;
  selectedDetail.value = undefined;
  detailLoading.value = false;
  detailError.value = '';
}

watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) void initialize();
    else {
      leaderboard.clear();
      response.value = undefined;
      closeDetail();
    }
  },
);

onMounted(() => {
  if (auth.isLoggedIn) void initialize();
});
</script>

<template>
  <div class="leaderboard">
    <template v-if="!auth.isLoggedIn">
      <section class="leaderboard__auth">
        <span class="leaderboard__auth-icon" aria-hidden="true"><Trophy /></span>
        <h1>Leaderboard</h1>
        <p>Bitte anmelden.</p>
        <QButton @click="ui.openAuthModal()">Anmelden</QButton>
      </section>
    </template>

    <template v-else>
      <header class="leaderboard__header">
        <h1>Leaderboard</h1>
        <div class="leaderboard__segments" role="radiogroup" aria-label="Zeitraum">
          <button
            type="button"
            role="radio"
            :aria-checked="period === 'today'"
            :class="{ 'leaderboard__segment--active': period === 'today' }"
            @click="selectPeriod('today')"
          >
            Heute
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="period === 'week'"
            :class="{ 'leaderboard__segment--active': period === 'week' }"
            @click="selectPeriod('week')"
          >
            Diese Woche
          </button>
        </div>
      </header>

      <div v-if="loadError" class="leaderboard__notice leaderboard__notice--error" role="alert">
        <span>{{ loadError }}</span>
        <button type="button" @click="loadList(true)">Erneut versuchen</button>
      </div>

      <section class="leaderboard__list" aria-label="Leaderboard">
        <div class="leaderboard__columns" aria-hidden="true">
          <span>Rang</span>
          <span>Nickname</span>
          <span>Aufgaben · {{ periodLabel }}</span>
          <span>Gesamt</span>
          <span>Punkte</span>
          <span />
        </div>

        <div v-if="loading" class="leaderboard__loading" role="status">
          Leaderboard wird geladen …
        </div>
        <div v-else-if="response?.items.length === 0" class="leaderboard__empty">
          Noch keine Einträge.
        </div>
        <div v-else class="leaderboard__rows">
          <LeaderboardRow
            v-for="item in response?.items"
            :key="item.profileId"
            :item="item"
            :period="period"
            @open="openDetail"
          />
        </div>
      </section>

      <div v-if="canLoadMore" class="leaderboard__more">
        <QButton variant="ghost" :disabled="loadingMore" @click="loadList(false)">
          {{ loadingMore ? 'Wird geladen …' : 'Mehr anzeigen' }}
        </QButton>
      </div>

      <section v-if="!isParticipating" class="leaderboard__profile">
        <form class="leaderboard__join" @submit.prevent="saveProfile">
          <label for="leaderboard-nickname">Nickname</label>
          <input
            id="leaderboard-nickname"
            v-model="nickname"
            autocomplete="nickname"
            maxlength="32"
            :disabled="savingProfile"
          />
          <QButton type="submit" :disabled="savingProfile">
            {{ savingProfile ? 'Wird gespeichert …' : 'Beitreten' }}
          </QButton>
        </form>
        <div v-if="profileError" class="leaderboard__profile-error" role="alert">{{ profileError }}</div>
      </section>

      <section v-else class="leaderboard__profile leaderboard__profile--joined">
        <div v-if="!editingNickname" class="leaderboard__profile-actions">
          <div class="leaderboard__profile-identity">
            <span>Dein Nickname</span>
            <strong>{{ profile?.participating ? profile.nickname : '' }}</strong>
          </div>
          <div class="leaderboard__profile-buttons">
            <QButton variant="secondary" @click="editingNickname = true">
              <Pencil aria-hidden="true" />
              Ändern
            </QButton>
            <QButton variant="danger" :disabled="savingProfile" @click="leaveLeaderboard">
              <LogOut aria-hidden="true" />
              Verlassen
            </QButton>
          </div>
        </div>
        <form v-else class="leaderboard__join" @submit.prevent="saveProfile">
          <label for="leaderboard-nickname-edit">Nickname</label>
          <input
            id="leaderboard-nickname-edit"
            v-model="nickname"
            autocomplete="nickname"
            maxlength="32"
            :disabled="savingProfile"
          />
          <QButton type="submit" :disabled="savingProfile">Speichern</QButton>
          <QButton variant="ghost" @click="editingNickname = false; syncNicknameField()">Abbrechen</QButton>
        </form>
        <div v-if="profileError" class="leaderboard__profile-error" role="alert">{{ profileError }}</div>
      </section>
    </template>

    <LeaderboardDetailDrawer
      :open="selectedProfileId !== undefined"
      :detail="selectedDetail"
      :loading="detailLoading"
      :error="detailError"
      @close="closeDetail"
      @retry="retryDetail"
    />
  </div>
</template>

<style scoped>
.leaderboard {
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 24px 38px;
}

.leaderboard__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 22px;
}

.leaderboard__header h1,
.leaderboard__auth h1 {
  margin: 0;
  font-size: 27px;
  font-weight: 800;
  letter-spacing: -0.035em;
}

.leaderboard__segments {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 268px;
  padding: 4px;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: var(--q-panel);
}

.leaderboard__segments button {
  min-height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--q-mut);
  cursor: pointer;
  font: 700 12px 'Public Sans', system-ui, sans-serif;
  transition: background var(--q-transition-fast), color var(--q-transition-fast);
}

.leaderboard__segments button:hover {
  color: var(--q-ink);
}

.leaderboard__segments button:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--q-accent);
  outline-offset: -2px;
}

.leaderboard__segments .leaderboard__segment--active {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}

.leaderboard__list {
  min-width: 0;
}

.leaderboard__columns {
  min-height: 34px;
  display: grid;
  grid-template-columns: 64px minmax(170px, 1fr) 116px 96px 96px 24px;
  align-items: center;
  gap: 14px;
  padding: 0 16px 7px;
  border-bottom: 1px solid var(--q-border);
  color: var(--q-faint);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.leaderboard__columns span:first-child {
  text-align: center;
}

.leaderboard__columns span:nth-child(n + 3) {
  text-align: right;
}

.leaderboard__columns span:nth-child(3) {
  color: var(--q-accent-strong);
}

.leaderboard__rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 9px;
}

.leaderboard__loading,
.leaderboard__empty {
  margin-top: 9px;
  padding: 56px 20px;
  border: 1px solid var(--q-border);
  border-radius: 11px;
  background: var(--q-card);
  color: var(--q-mut);
  font-size: 13px;
  text-align: center;
}

.leaderboard__more {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

.leaderboard__profile {
  position: sticky;
  bottom: 14px;
  z-index: 8;
  margin-top: 24px;
  padding: 14px;
  border: 1px solid var(--q-border-2);
  border-radius: 11px;
  background: color-mix(in srgb, var(--q-card) 94%, transparent);
  backdrop-filter: blur(12px);
}

.leaderboard__join {
  display: grid;
  grid-template-columns: auto minmax(200px, 1fr) auto auto;
  gap: 10px;
  align-items: center;
}

.leaderboard__join label {
  color: var(--q-mut);
  font-size: 11px;
  font-weight: 700;
}

.leaderboard__join input {
  width: 100%;
  min-height: 40px;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  background: var(--q-card);
  color: var(--q-ink);
  font: 500 14px 'Public Sans', system-ui, sans-serif;
}

.leaderboard__join input:focus {
  border-color: var(--q-accent);
  outline: 2px solid var(--q-accent-ring);
  outline-offset: 1px;
}

.leaderboard__join :deep(.q-btn) {
  min-height: 40px;
}

.leaderboard__profile-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.leaderboard__profile-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: auto;
}

.leaderboard__profile-identity span {
  color: var(--q-mut);
  font-size: 11px;
}

.leaderboard__profile-identity strong {
  overflow: hidden;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leaderboard__profile-buttons {
  display: grid;
  grid-template-columns: repeat(2, auto);
  gap: 6px;
}

.leaderboard__profile-buttons :deep(.q-btn) {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.leaderboard__profile-buttons :deep(.q-btn svg) {
  width: 14px;
  height: 14px;
}

.leaderboard__profile-error {
  margin-top: 10px;
  color: var(--q-err);
  font-size: 12px;
  font-weight: 600;
}

.leaderboard__notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  padding: 11px 14px;
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  background: var(--q-err-bg);
  color: var(--q-err-text);
  font-size: 12px;
}
.leaderboard__notice button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: 700 12px 'Public Sans', system-ui, sans-serif;
  text-decoration: underline;
}

.leaderboard__auth {
  width: min(380px, 100%);
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin: min(15vh, 120px) auto 0;
  padding: 36px;
  border: 1px solid var(--q-border);
  border-radius: 13px;
  background: var(--q-card);
  text-align: center;
}

.leaderboard__auth-icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  margin-bottom: 18px;
  border-radius: 50%;
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
}

.leaderboard__auth-icon svg {
  width: 24px;
  height: 24px;
}

.leaderboard__auth p {
  margin: 8px 0 20px;
  color: var(--q-mut);
  font-size: 13px;
}

@media (max-width: 700px) {
  .leaderboard {
    padding: 20px 12px calc(92px + env(safe-area-inset-bottom));
  }

  .leaderboard__header {
    gap: 14px;
    margin-bottom: 18px;
  }

  .leaderboard__header h1 {
    font-size: 22px;
  }

  .leaderboard__segments {
    width: 190px;
  }

  .leaderboard__segments button {
    min-height: 34px;
    padding: 0 10px;
    font-size: 10.5px;
  }

  .leaderboard__columns {
    display: none;
  }

  .leaderboard__profile {
    bottom: calc(66px + env(safe-area-inset-bottom));
    margin-top: 18px;
    padding: 12px;
  }

  .leaderboard__join {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .leaderboard__join :deep(.q-btn) {
    width: 100%;
  }

  .leaderboard__profile-actions {
    display: grid;
    gap: 12px;
  }

  .leaderboard__profile-identity {
    margin: 0;
  }

  .leaderboard__profile-buttons {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .leaderboard__profile-buttons :deep(.q-btn) {
    width: 100%;
  }

  .leaderboard__auth {
    margin-top: 10vh;
    padding: 28px 20px;
  }
}
</style>
