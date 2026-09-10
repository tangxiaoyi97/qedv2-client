<script setup lang="ts">
import { useI18n } from '../i18n.js';
const { t } = useI18n();

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ApiError, type LeaderboardDetail, type LeaderboardPeriod, type LeaderboardResponse } from '@qed2/core-logic';
import { LeaderboardDetailDrawer, LeaderboardRow, QButton, QLoadingPanel } from '@qed2/ui';
import { LogOut, Pencil, Trophy, UserRound } from 'lucide-vue-next';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useLeaderboardStore } from '../stores/leaderboard.js';
import { useUiStore } from '../stores/ui.js';

const PAGE_SIZE = 50;

const app = useAppStore();
const auth = useAuthStore();
const leaderboard = useLeaderboardStore();
const ui = useUiStore();

const period = ref<LeaderboardPeriod>('today');
const response = ref<LeaderboardResponse | undefined>();
const loading = ref(false);
const showRefreshing = ref(false);
const showProfileLoading = ref(false);
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
let scope = 0;
let disposed = false;
let listController: AbortController | undefined;
let detailController: AbortController | undefined;
let failedListReset = true;
let failedListPeriod: LeaderboardPeriod = 'today';
let lastPageLength = 0;

const profile = computed(() => leaderboard.profile);
const profileLoadError = computed(() => leaderboard.profileError);
const isParticipating = computed(() => profile.value?.participating === true);
// Keep the displayed columns and counts tied to the last completed request.
// Selecting a period must not relabel yesterday's rows while its request runs.
const displayedPeriod = computed(() => response.value?.period ?? period.value);
const periodLabel = computed(() => (displayedPeriod.value === 'today' ? 'heute' : 'diese Woche'));
const canLoadMore = computed(
  () =>
    response.value !== undefined && response.value.page < 1000 && lastPageLength > 0 &&
    response.value.items.length < response.value.totalParticipants,
);

function syncNicknameField(): void {
  const current = profile.value;
  if (current?.participating) nickname.value = current.nickname;
  else nickname.value = current?.suggestedNickname || auth.username || '';
}

async function loadList(reset = true): Promise<void> {
  if (!auth.isLoggedIn || disposed || (!reset && (loading.value || loadingMore.value || !canLoadMore.value))) return;
  const request = ++listRequest;
  const requestScope = scope;
  const requestedPeriod = period.value;
  listController?.abort();
  listController = new AbortController();
  const page = reset ? 1 : (response.value?.page ?? 0) + 1;
  if (reset) loading.value = true;
  else loadingMore.value = true;
  if (reset) loadingMore.value = false;
  loadError.value = '';
  try {
    let cacheScope: ReturnType<typeof leaderboard.captureListScope>;
    do {
      const ready = await leaderboard.waitForListMutation();
      if (!ready || request !== listRequest || requestScope !== scope || disposed) return;
      cacheScope = leaderboard.captureListScope();
      // A second write may begin while the previous waiter's microtask is
      // being resumed. Start the GET only after capturing a write-free scope.
    } while (!cacheScope);
    const next = await app.serverClient.getLeaderboard({
      period: requestedPeriod,
      page,
      pageSize: PAGE_SIZE,
    }, { signal: listController.signal });
    if (request !== listRequest || requestScope !== scope || disposed) return;
    if (next.period !== requestedPeriod || next.page !== page) throw new Error('Unexpected leaderboard page');
    lastPageLength = next.items.length;
    // Rankings may move between page requests. Keep each public profile once;
    // the latest response wins without accumulating duplicate row keys.
    const items = reset || !response.value ? next.items :
      [...new Map([...response.value.items, ...next.items].map((item) => [item.profileId, item])).values()]
        .sort((left, right) => left.rank - right.rank);
    response.value = { ...next, items };
    if (reset && cacheScope) leaderboard.rememberList(next, cacheScope);
  } catch (error) {
    if (request !== listRequest || requestScope !== scope || disposed) return;
    if (reset && response.value) period.value = response.value.period;
    failedListReset = reset;
    failedListPeriod = requestedPeriod;
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

function retryList(): void {
  period.value = failedListPeriod;
  void loadList(failedListReset);
}

async function retryProfile(): Promise<void> {
  const requestScope = scope;
  const previousNickname = nickname.value;
  await leaderboard.refreshProfile();
  if (requestScope === scope && !disposed && !editingNickname.value && nickname.value === previousNickname) syncNicknameField();
}

async function initialize(): Promise<void> {
  if (!auth.isLoggedIn || disposed) return;
  // The requested default is useful immediately, even before the profile
  // request returns on a slow connection.
  if (!nickname.value) syncNicknameField();
  await Promise.all([retryProfile(), loadList(true)]);
}

async function selectPeriod(next: LeaderboardPeriod): Promise<void> {
  if (period.value === next) return;
  period.value = next;
  await loadList(true);
}

function onPeriodKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'today' : 'week';
  (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')[next === 'today' ? 0 : 1]?.focus();
  void selectPeriod(next);
}

function friendlyProfileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NICKNAME_TAKEN') return 'Dieser Nickname ist bereits vergeben.';
    if (error.code === 'VALIDATION_FAILED') return 'Der Nickname muss 2–32 sichtbare Zeichen haben.';
  }
  return 'Die Änderung konnte nicht gespeichert werden.';
}

async function saveProfile(): Promise<void> {
  if (savingProfile.value || !auth.isLoggedIn || disposed) return;
  const requestScope = scope;
  savingProfile.value = true;
  profileError.value = '';
  try {
    await leaderboard.saveNickname(nickname.value);
    if (requestScope !== scope || disposed) return;
    syncNicknameField();
    editingNickname.value = false;
    await loadList(true);
  } catch (error) {
    if (requestScope === scope && !disposed) profileError.value = friendlyProfileError(error);
  } finally {
    if (requestScope === scope) savingProfile.value = false;
  }
}

async function leaveLeaderboard(): Promise<void> {
  if (savingProfile.value || !auth.isLoggedIn || disposed) return;
  const requestScope = scope;
  savingProfile.value = true;
  profileError.value = '';
  try {
    await leaderboard.leave();
    if (requestScope !== scope || disposed) return;
    closeDetail();
    // Do not keep showing a departed public profile if the next read fails.
    response.value = undefined;
    syncNicknameField();
    editingNickname.value = false;
    await loadList(true);
  } catch {
    if (requestScope === scope && !disposed) profileError.value = 'Das Leaderboard konnte nicht verlassen werden.';
  } finally {
    if (requestScope === scope) savingProfile.value = false;
  }
}

async function loadDetail(profileId: string): Promise<void> {
  if (!auth.isLoggedIn || disposed) return;
  const request = ++detailRequest;
  const requestScope = scope;
  detailController?.abort();
  detailController = new AbortController();
  selectedDetail.value = undefined;
  detailLoading.value = true;
  detailError.value = '';
  try {
    const detail = await app.serverClient.getLeaderboardDetail(profileId, { signal: detailController.signal });
    if (request === detailRequest && requestScope === scope && !disposed) selectedDetail.value = detail;
  } catch {
    if (request === detailRequest) {
      detailError.value = 'Die Details konnten nicht geladen werden.';
    }
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

async function openDetail(profileId: string): Promise<void> {
  if (!auth.isLoggedIn || disposed) return;
  selectedProfileId.value = profileId;
  await loadDetail(profileId);
}

function retryDetail(): void {
  if (selectedProfileId.value) void loadDetail(selectedProfileId.value);
}

function closeDetail(): void {
  detailRequest += 1;
  detailController?.abort();
  detailController = undefined;
  selectedProfileId.value = undefined;
  selectedDetail.value = undefined;
  detailLoading.value = false;
  detailError.value = '';
}

function resetRequests(): void {
  scope += 1;
  listRequest += 1;
  listController?.abort();
  listController = undefined;
  response.value = undefined;
  loading.value = false;
  loadingMore.value = false;
  loadError.value = '';
  profileError.value = '';
  savingProfile.value = false;
  nickname.value = '';
  editingNickname.value = false;
  lastPageLength = 0;
  closeDetail();
}

watch(() => [auth.session?.user.id, auth.session?.token, app.config.serverBaseUrl, auth.isLoggedIn], () => {
  resetRequests();
  const cached = leaderboard.cachedList();
  if (cached) {
    response.value = cached;
    period.value = cached.period;
    lastPageLength = cached.items.length;
  }
  if (auth.isLoggedIn) void initialize();
}, { immediate: true, flush: 'sync' });

watch(() => leaderboard.listMutationRevision, () => {
  // A write started on the previous route can finish after this instance
  // mounts. Its old caller is disposed and can no longer refresh our list.
  if (!savingProfile.value && auth.isLoggedIn && !disposed) void loadList(true);
});

watch(loading, (pending, _previous, onCleanup) => {
  showRefreshing.value = false;
  if (!pending) return;
  // Fast reads update in place without a one-frame loading flash.
  const timer = setTimeout(() => { showRefreshing.value = true; }, 160);
  onCleanup(() => clearTimeout(timer));
}, { immediate: true, flush: 'sync' });

watch(() => leaderboard.loadingProfile && !profile.value, (pending, _previous, onCleanup) => {
  showProfileLoading.value = false;
  if (!pending) return;
  const timer = setTimeout(() => { showProfileLoading.value = true; }, 160);
  onCleanup(() => clearTimeout(timer));
}, { immediate: true, flush: 'sync' });

onBeforeUnmount(() => {
  disposed = true;
  resetRequests();
});
</script>

<template>
  <div class="leaderboard q-page">
    <template v-if="!auth.isLoggedIn">
      <section class="leaderboard__auth">
        <span class="leaderboard__auth-icon" aria-hidden="true"><Trophy /></span>
        <h1 class="q-page-title">{{ t('Leaderboard') }}</h1>
        <QButton @click="ui.openAuthModal()">{{ t('Anmelden') }}</QButton>
      </section>
    </template>

    <template v-else>
      <header class="leaderboard__header">
        <h1 class="q-page-title">{{ t('Leaderboard') }}</h1>
        <div class="leaderboard__segments" role="radiogroup" :aria-label="t('Zeitraum')" @keydown="onPeriodKeydown">
          <button
            type="button"
            role="radio"
            :aria-checked="period === 'today'"
            :tabindex="period === 'today' ? 0 : -1"
            :class="{ 'leaderboard__segment--active': period === 'today' }"
            @click="selectPeriod('today')"
          >
            {{ t('Heute') }}
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="period === 'week'"
            :tabindex="period === 'week' ? 0 : -1"
            :class="{ 'leaderboard__segment--active': period === 'week' }"
            @click="selectPeriod('week')"
          >
            {{ t('Diese Woche') }}
          </button>
        </div>
      </header>

      <div v-if="loadError" class="leaderboard__notice leaderboard__notice--error" role="alert">
        <span>{{ t(loadError) }}</span>
        <QButton variant="ghost" :loading="loading || loadingMore" @click="retryList">{{ t('Erneut versuchen') }}</QButton>
      </div>

      <section class="leaderboard__list" :aria-label="t('Leaderboard')" :aria-busy="loading || loadingMore">
        <div class="leaderboard__columns" aria-hidden="true">
          <span>{{ t('Rang') }}</span>
          <span>{{ t('Nickname') }}</span>
          <span :title="`${t('Aufgaben ·')} ${t(periodLabel)}`">{{ t(displayedPeriod === 'today' ? 'Heute' : 'Diese Woche') }}</span>
          <span>{{ t('Gesamt') }}</span>
          <span>{{ t('Punkte') }}</span>
          <span />
        </div>

        <div class="leaderboard__stage">
        <QLoadingPanel v-if="loading && !response && showRefreshing" :label="t('Leaderboard wird geladen …')" class="leaderboard__loading" />
        <div v-else-if="response?.items.length === 0" key="empty" class="leaderboard__empty" role="status">
          {{ t('Noch keine Einträge.') }}
        </div>
        <div v-else key="rows" class="leaderboard__rows" :class="{ 'leaderboard__rows--refreshing': showRefreshing && displayedPeriod !== period }">
          <LeaderboardRow
            v-for="item in response?.items"
            :key="item.profileId"
            :item="item"
            :period="displayedPeriod"
            @open="openDetail"
          />
        </div>
        </div>
      </section>

      <div v-if="canLoadMore" class="leaderboard__more">
        <QButton variant="ghost" :loading="loadingMore" :disabled="loading" @click="loadList(false)">
          {{ t('Mehr anzeigen') }}
        </QButton>
      </div>

      <section v-if="!profile && leaderboard.loadingProfile && showProfileLoading" class="leaderboard__profile">
        <QLoadingPanel bare :label="t('Wird geladen …')" />
      </section>
      <section v-else-if="!profile && profileLoadError" class="leaderboard__notice leaderboard__notice--error leaderboard__profile-status" role="alert">
        <span>{{ t(profileLoadError) }}</span>
        <QButton variant="ghost" @click="retryProfile">{{ t('Erneut versuchen') }}</QButton>
      </section>
      <section v-else-if="profile && !isParticipating" class="leaderboard__profile">
        <form class="leaderboard__join" @submit.prevent="saveProfile">
          <div class="leaderboard__nickname-field">
          <label for="leaderboard-nickname">{{ t('Nickname') }}</label>
          <input
            id="leaderboard-nickname"
            class="q-input"
            v-model="nickname"
            autocomplete="nickname"
            maxlength="32"
            minlength="2"
            required
            :disabled="savingProfile"
            :aria-invalid="profileError ? true : undefined"
            :aria-describedby="profileError ? 'leaderboard-profile-error' : undefined"
          />
          </div>
          <QButton type="submit" :loading="savingProfile">
            {{ t('Beitreten') }}
          </QButton>
        </form>
        <div v-if="profileError" id="leaderboard-profile-error" class="leaderboard__profile-error" role="alert">{{ t(profileError) }}</div>
      </section>

      <section v-else-if="isParticipating" class="leaderboard__profile leaderboard__profile--joined">
        <div v-if="!editingNickname" class="leaderboard__profile-actions">
          <div class="leaderboard__profile-identity">
            <span class="leaderboard__profile-avatar" aria-hidden="true">
              <UserRound />
            </span>
            <span class="leaderboard__profile-copy">
              <strong>{{ profile?.participating ? profile.nickname : '' }}</strong>
            </span>
          </div>
          <div class="leaderboard__profile-buttons">
            <QButton variant="secondary" :disabled="savingProfile" @click="editingNickname = true">
              <Pencil aria-hidden="true" />
              {{ t('Ändern') }}
            </QButton>
            <QButton variant="danger" :loading="savingProfile" @click="leaveLeaderboard">
              <LogOut aria-hidden="true" />
              {{ t('Verlassen') }}
            </QButton>
          </div>
        </div>
        <form v-else class="leaderboard__join" @submit.prevent="saveProfile">
          <div class="leaderboard__nickname-field">
          <label for="leaderboard-nickname-edit">{{ t('Nickname') }}</label>
          <input
            id="leaderboard-nickname-edit"
            class="q-input"
            v-model="nickname"
            autocomplete="nickname"
            maxlength="32"
            minlength="2"
            required
            :disabled="savingProfile"
            :aria-invalid="profileError ? true : undefined"
            :aria-describedby="profileError ? 'leaderboard-profile-error' : undefined"
          />
          </div>
          <div class="leaderboard__form-actions">
          <QButton type="submit" :loading="savingProfile">{{ t('Speichern') }}</QButton>
          <QButton variant="ghost" :disabled="savingProfile" @click="editingNickname = false; syncNicknameField()">{{ t('Abbrechen') }}</QButton>
          </div>
        </form>
        <div v-if="profileError" id="leaderboard-profile-error" class="leaderboard__profile-error" role="alert">{{ t(profileError) }}</div>
      </section>
    </template>

    <LeaderboardDetailDrawer
      :open="selectedProfileId !== undefined"
      :detail="selectedDetail"
      :loading="detailLoading"
      :error="t(detailError)"
      @close="closeDetail"
      @retry="retryDetail"
    />
  </div>
</template>

<style scoped>
.leaderboard {
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 24px 40px;
}

.leaderboard__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.leaderboard__header h1,
.leaderboard__auth h1 {
  margin: 0;
}

.leaderboard__segments {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 280px;
  flex: none;
  padding: 4px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-control);
  background: var(--q-panel);
}

.leaderboard__segments button {
  min-height: var(--q-control-height);
  padding: 0 16px;
  border: 0;
  border-radius: calc(var(--q-radius-control) - 4px);
  background: transparent;
  color: var(--q-mut);
  cursor: pointer;
  font: 600 var(--q-font-ui)/1.3 'Public Sans', system-ui, sans-serif;
  transition: background var(--q-transition-fast), color var(--q-transition-fast);
}

.leaderboard__segments button:not(.leaderboard__segment--active):hover {
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

.leaderboard__stage { min-height: 160px; }

.leaderboard__columns {
  min-height: 40px;
  display: grid;
  grid-template-columns: var(--q-leaderboard-columns);
  align-items: center;
  gap: 16px;
  padding: 0 16px 8px;
  border-bottom: 1px solid var(--q-border);
  color: var(--q-mut);
  font-size: var(--q-font-small);
  font-weight: 600;
}

.leaderboard__columns span {
  min-width: 0;
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
  padding-top: 8px;
  transition: opacity var(--q-transition-fast);
}

.leaderboard__rows--refreshing {
  opacity: 0.6;
}

.leaderboard__loading {
  margin-top: 8px;
}
.leaderboard__empty {
  margin-top: 8px;
  padding: 48px 24px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-card);
  background: var(--q-card);
  color: var(--q-mut);
  font-size: var(--q-font-ui);
  text-align: center;
}

.leaderboard__more {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

.leaderboard__profile {
  margin-top: 24px;
  padding: 16px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-card);
  background: var(--q-card);
}

.leaderboard__join {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: end;
}

.leaderboard__nickname-field {
  min-width: 0;
  display: grid;
  gap: 8px;
}

.leaderboard__form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.leaderboard__join label {
  color: var(--q-mut);
  font-size: var(--q-font-small);
  font-weight: 700;
}

.leaderboard__join input {
  min-width: 0;
  width: 100%;
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
  gap: 12px;
  margin-right: auto;
}

.leaderboard__profile-avatar {
  width: 40px;
  height: 40px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--q-accent) 32%, var(--q-border));
  border-radius: 50%;
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
}

.leaderboard__profile-avatar svg {
  width: 20px;
  height: 20px;
  stroke-width: 1.9;
}

.leaderboard__profile-copy {
  min-width: 0;
  display: block;
}

.leaderboard__profile-copy strong {
  display: block;
  overflow: hidden;
  color: var(--q-ink-2);
  font-size: var(--q-font-ui);
  font-weight: 700;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leaderboard__profile-buttons {
  display: grid;
  grid-template-columns: repeat(2, auto);
  gap: 8px;
}

.leaderboard__profile-buttons :deep(.q-btn) {
  min-height: var(--q-control-height);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.leaderboard__profile-buttons :deep(.q-btn svg) {
  width: 16px;
  height: 16px;
}

.leaderboard__profile-error {
  margin-top: 12px;
  color: var(--q-err);
  font-size: var(--q-font-small);
  font-weight: 600;
}

.leaderboard__notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid var(--q-err-border);
  border-radius: var(--q-radius-control);
  background: var(--q-err-bg);
  color: var(--q-err-text);
  font-size: var(--q-font-small);
}
.leaderboard__notice :deep(.q-btn) {
  flex: none;
  color: inherit;
}
.leaderboard__profile-status {
  margin-top: 24px;
}

.leaderboard__auth {
  width: min(380px, 100%);
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  margin: min(15vh, 120px) auto 0;
  padding: 32px;
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-card);
  background: var(--q-card);
  text-align: center;
}

.leaderboard__auth-icon {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
}

.leaderboard__auth-icon svg {
  width: 28px;
  height: 28px;
}

@media (max-width: 700px) {
  .leaderboard {
    padding: 20px 12px calc(92px + env(safe-area-inset-bottom));
  }

  .leaderboard__header {
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 16px;
  }

  .leaderboard__segments {
    width: min(280px, 100%);
  }

  .leaderboard__segments button {
    padding: 0 12px;
  }

  .leaderboard__columns {
    gap: 8px;
    padding: 0 8px 8px;
  }

  .leaderboard__columns span:first-child {
    overflow: hidden;
    font-size: 10px;
  }

  .leaderboard__columns span:nth-child(3) {
    line-height: 1.2;
  }

  .leaderboard__profile {
    margin-top: 24px;
    padding: 12px;
  }

  .leaderboard__join {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .leaderboard__join :deep(.q-btn) {
    width: 100%;
  }

  .leaderboard__form-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
    padding: 32px 24px;
  }

  .leaderboard__notice {
    align-items: start;
    flex-direction: column;
    gap: 8px;
  }

  .leaderboard__notice :deep(.q-btn) {
    align-self: end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .leaderboard__rows,
  .leaderboard__segments button {
    transition: none;
  }
}
</style>
