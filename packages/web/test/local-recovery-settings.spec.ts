import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import {
  accountStorageIdentity,
  userLocalProfileId,
  type LocalRecoveryInventory,
} from '@qed2/core-logic';

const SERVER_URL = 'https://server.example';
const REMOTE_USER_ID = 'remote-user';
const OWNER_ID = accountStorageIdentity(SERVER_URL, REMOTE_USER_ID);
const ACCOUNT_PROFILE = userLocalProfileId(OWNER_ID);
const GUEST_PROFILE = 'guest:11111111-1111-4111-8111-111111111111' as const;
const RECOVERY_PROFILE = 'guest:22222222-2222-4222-8222-222222222222' as const;

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  exportRecovery: vi.fn(async () => ({
    format: 'qed2-local-recovery.v1' as const,
    exportedAt: '2026-08-15T00:00:00.000Z',
    profiles: [],
    ambiguousAttempts: [],
    ambiguousAccountAttempts: [],
    corruptAttempts: [],
    legacySyncMutations: [],
    unclaimedGuestAttempts: [],
    orphanedPracticeSessions: [],
  })),
  assign: vi.fn(async () => undefined),
  assignLegacyPendingAccount: vi.fn(async () => undefined),
  refreshProfiles: vi.fn(async () => undefined),
  currentProfile: vi.fn(),
  pendingGuestClaimRoute: vi.fn(async (): Promise<{
    sourceGeneration: string;
    destinationUserId: string;
  } | undefined> => undefined),
  pendingLegacyAccountRecovery: vi.fn(async (): Promise<{
    sourceGeneration: string;
    sourceProfileId: typeof GUEST_PROFILE;
    legacyUserId: string;
    scopedUserId: string;
  } | undefined> => undefined),
  migrateLegacyAccountIdentity: vi.fn(async () => undefined),
  appStore: {
    theme: 'light' as const,
    accentTheme: 'weed' as const,
    config: { coreBaseUrl: 'https://core.example', serverBaseUrl: 'https://server.example' },
    coreInfo: undefined,
    serverInfo: undefined,
    setTheme: vi.fn(),
    setAccentTheme: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    refreshServiceInfo: vi.fn(async () => undefined),
  },
  authStore: {
    isLoggedIn: true,
    session: {
      token: 'test-token',
      expiresAt: '2026-08-16T00:00:00.000Z',
      serverBaseUrl: 'https://server.example',
      user: { id: 'remote-user', username: 'tester' },
    },
    logout: vi.fn(async () => undefined),
  },
  leaderboardStore: {
    loadingProfile: false,
    profile: undefined,
    refreshProfile: vi.fn(async () => undefined),
    clear: vi.fn(),
  },
  progressStore: {
    syncStatus: { state: 'idle' as const },
    syncNow: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    claimGuestAttempts: vi.fn(async () => 0),
    flushAttemptOutbox: vi.fn(async () => undefined),
  },
  uiStore: {
    locale: 'de',
    appCommit: 'test',
    t: (key: string) => key === 'settingsLanguage' ? 'Sprache' : key,
    setLocale: vi.fn(),
    openAuthModal: vi.fn(),
    showChangelogHistory: vi.fn(async () => true),
  },
}));

const {
  inventory,
  exportRecovery,
  assign,
  assignLegacyPendingAccount,
  refreshProfiles,
  currentProfile,
  pendingGuestClaimRoute,
  pendingLegacyAccountRecovery,
  migrateLegacyAccountIdentity,
  appStore,
  authStore,
  leaderboardStore,
  progressStore,
  uiStore,
} = mocks;

vi.mock('../src/services.js', () => ({
  APP_VERSION: 'test',
  localProfileStore: {
    currentIfInitialized: mocks.currentProfile,
    refresh: mocks.refreshProfiles,
  },
  localRecoveryStore: {
    inventory: mocks.inventory,
    export: mocks.exportRecovery,
    assign: mocks.assign,
    assignLegacyPendingAccount: mocks.assignLegacyPendingAccount,
  },
  attemptOutbox: {
    pendingGuestClaimRoute: mocks.pendingGuestClaimRoute,
    pendingLegacyAccountRecovery: mocks.pendingLegacyAccountRecovery,
    migrateLegacyAccountIdentity: mocks.migrateLegacyAccountIdentity,
  },
  ports: {},
}));

vi.mock('../src/stores/app.js', () => ({ useAppStore: () => mocks.appStore }));
vi.mock('../src/stores/auth.js', () => ({ useAuthStore: () => mocks.authStore }));
vi.mock('../src/stores/leaderboard.js', () => ({
  useLeaderboardStore: () => mocks.leaderboardStore,
}));
vi.mock('../src/stores/progress.js', () => ({ useProgressStore: () => mocks.progressStore }));
vi.mock('../src/stores/ui.js', () => ({ useUiStore: () => mocks.uiStore }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../src/routes/settings/AiSettings.vue', () => ({
  default: { template: '<div data-ai-settings />' },
}));

import SettingsView from '../src/routes/SettingsView.vue';

let mounted: { app: App; host: HTMLElement } | undefined;

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function mountSettings(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsView);
  app.mount(host);
  mounted = { app, host };
  return host;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label));
  if (!found) throw new Error(`Button not found: ${label}`);
  return found as HTMLButtonElement;
}

function emptyInventory(): LocalRecoveryInventory {
  return {
    totalCount: 0,
    profileCount: 0,
    ambiguousAttemptCount: 0,
    ambiguousAccountAttemptCount: 0,
    corruptAttemptCount: 0,
    legacySyncMutationCount: 0,
    orphanedPracticeSessionCount: 0,
    profiles: [],
  };
}

describe('local recovery settings', () => {
  beforeEach(() => {
    inventory.mockReset();
    inventory.mockResolvedValue(emptyInventory());
    assign.mockClear();
    assignLegacyPendingAccount.mockClear();
    refreshProfiles.mockClear();
    currentProfile.mockClear();
    currentProfile.mockReturnValue(ACCOUNT_PROFILE);
    progressStore.claimGuestAttempts.mockClear();
    progressStore.flushAttemptOutbox.mockClear();
    progressStore.syncNow.mockClear();
    progressStore.refresh.mockClear();
    pendingGuestClaimRoute.mockReset();
    pendingGuestClaimRoute.mockResolvedValue(undefined);
    pendingLegacyAccountRecovery.mockReset();
    pendingLegacyAccountRecovery.mockResolvedValue(undefined);
    migrateLegacyAccountIdentity.mockClear();
    authStore.isLoggedIn = true;
    authStore.session = {
      token: 'test-token',
      expiresAt: '2026-08-16T00:00:00.000Z',
      serverBaseUrl: SERVER_URL,
      user: { id: REMOTE_USER_ID, username: 'tester' },
    };
  });

  afterEach(() => {
    mounted?.app.unmount();
    mounted = undefined;
    document.body.innerHTML = '';
  });

  it('does not render an entry when no isolated data exists', async () => {
    const host = mountSettings();
    await settle();

    expect(host.textContent).not.toContain('Lokale Daten');
    expect(inventory).toHaveBeenCalledWith(ACCOUNT_PROFILE);
  });

  it('claims unassigned guest data only after the explicit confirmation', async () => {
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'unclaimed-guest',
        profileId: GUEST_PROFILE,
        hasArchive: true,
        historyCount: 2,
        historyEventCount: 0,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    const host = mountSettings();
    await settle();

    expect(host.textContent).toContain('Lokale Daten');
    button('Prüfen').click();
    await settle();
    expect(document.body.textContent).toContain('Besucherdaten');
    button('Wiederherstellen').click();
    await settle();
    expect(progressStore.claimGuestAttempts).not.toHaveBeenCalled();
    button('Zuordnen').click();
    await settle();
    await settle();

    expect(progressStore.claimGuestAttempts).toHaveBeenCalledWith(OWNER_ID, GUEST_PROFILE);
    expect(progressStore.flushAttemptOutbox).toHaveBeenCalledOnce();
    expect(progressStore.syncNow).toHaveBeenCalledWith({ quiet: true });
    expect(assign).not.toHaveBeenCalled();
  });

  it('restores a matching raw 2.1 quarantine only after explicit confirmation', async () => {
    pendingGuestClaimRoute.mockResolvedValue({
      sourceGeneration: 'legacy-guest',
      destinationUserId: REMOTE_USER_ID,
    });
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'quarantine',
        profileId: GUEST_PROFILE,
        hasArchive: true,
        historyCount: 0,
        historyEventCount: 0,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    mountSettings();
    await settle();
    button('Prüfen').click();
    await settle();
    button('Wiederherstellen').click();
    await settle();
    expect(assignLegacyPendingAccount).not.toHaveBeenCalled();

    button('Zuordnen').click();
    await settle();

    expect(assignLegacyPendingAccount).toHaveBeenCalledWith(
      GUEST_PROFILE,
      ACCOUNT_PROFILE,
      {
        legacyUserId: REMOTE_USER_ID,
        scopedUserId: OWNER_ID,
        sourceGeneration: 'legacy-guest',
      },
    );
    expect(progressStore.claimGuestAttempts).not.toHaveBeenCalled();
    expect(migrateLegacyAccountIdentity).not.toHaveBeenCalled();
  });

  it('resumes only a matching durable endpoint-scoped recovery binding', async () => {
    pendingLegacyAccountRecovery.mockResolvedValue({
      sourceGeneration: 'legacy-guest',
      sourceProfileId: GUEST_PROFILE,
      legacyUserId: REMOTE_USER_ID,
      scopedUserId: OWNER_ID,
    });
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'quarantine',
        profileId: GUEST_PROFILE,
        hasArchive: true,
        historyCount: 0,
        historyEventCount: 0,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    mountSettings();
    await settle();
    button('Prüfen').click();
    await settle();
    button('Wiederherstellen').click();
    await settle();
    button('Zuordnen').click();
    await settle();

    expect(pendingGuestClaimRoute).not.toHaveBeenCalled();
    expect(assignLegacyPendingAccount).toHaveBeenCalledWith(
      GUEST_PROFILE,
      ACCOUNT_PROFILE,
      {
        legacyUserId: REMOTE_USER_ID,
        scopedUserId: OWNER_ID,
        sourceGeneration: 'legacy-guest',
      },
    );
  });

  it('does not resume a recovery binding owned by another endpoint scope', async () => {
    pendingLegacyAccountRecovery.mockResolvedValue({
      sourceGeneration: 'legacy-guest',
      sourceProfileId: GUEST_PROFILE,
      legacyUserId: REMOTE_USER_ID,
      scopedUserId: `account-v1-${'f'.repeat(64)}`,
    });
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'quarantine',
        profileId: GUEST_PROFILE,
        hasArchive: true,
        historyCount: 0,
        historyEventCount: 0,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    mountSettings();
    await settle();
    button('Prüfen').click();
    await settle();
    button('Wiederherstellen').click();
    await settle();
    button('Zuordnen').click();
    await settle();

    expect(assignLegacyPendingAccount).not.toHaveBeenCalled();
    expect(progressStore.claimGuestAttempts).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Die Daten bleiben erhalten.');
  });

  it('never assigns a fresh guest profile through an older pending generation', async () => {
    pendingGuestClaimRoute.mockResolvedValue({
      sourceGeneration: 'old-guest-generation',
      destinationUserId: REMOTE_USER_ID,
    });
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'unclaimed-guest',
        profileId: GUEST_PROFILE,
        hasArchive: true,
        historyCount: 0,
        historyEventCount: 0,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    mountSettings();
    await settle();
    button('Prüfen').click();
    await settle();
    button('Wiederherstellen').click();
    await settle();
    button('Zuordnen').click();
    await settle();

    expect(progressStore.claimGuestAttempts).not.toHaveBeenCalled();
    expect(assignLegacyPendingAccount).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Die Daten bleiben erhalten.');
  });

  it('refuses a raw pending claim for another account', async () => {
    pendingGuestClaimRoute.mockResolvedValue({
      sourceGeneration: 'legacy-guest',
      destinationUserId: 'different-raw-user',
    });
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'quarantine',
        profileId: GUEST_PROFILE,
        hasArchive: true,
        historyCount: 0,
        historyEventCount: 0,
        attemptCount: 1,
        assignment: { safe: true },
      }],
    });
    mountSettings();
    await settle();
    button('Prüfen').click();
    await settle();
    button('Wiederherstellen').click();
    await settle();
    button('Zuordnen').click();
    await settle();

    expect(migrateLegacyAccountIdentity).not.toHaveBeenCalled();
    expect(assignLegacyPendingAccount).not.toHaveBeenCalled();
    expect(progressStore.claimGuestAttempts).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Die Daten bleiben erhalten.');
  });

  it('uses the atomic recovery store only for a quarantined profile', async () => {
    inventory.mockResolvedValue({
      totalCount: 1,
      profileCount: 1,
      ambiguousAttemptCount: 0,
      ambiguousAccountAttemptCount: 0,
      corruptAttemptCount: 0,
      legacySyncMutationCount: 0,
      orphanedPracticeSessionCount: 0,
      profiles: [{
        kind: 'quarantine',
        profileId: RECOVERY_PROFILE,
        hasArchive: true,
        historyCount: 0,
        historyEventCount: 0,
        attemptCount: 0,
        assignment: { safe: true },
      }],
    });
    mountSettings();
    await settle();
    button('Prüfen').click();
    await settle();
    button('Wiederherstellen').click();
    await settle();
    button('Zuordnen').click();
    await settle();

    expect(assign).toHaveBeenCalledWith(RECOVERY_PROFILE, ACCOUNT_PROFILE);
    expect(progressStore.claimGuestAttempts).not.toHaveBeenCalled();
  });
});
