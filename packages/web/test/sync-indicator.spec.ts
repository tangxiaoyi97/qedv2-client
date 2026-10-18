import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import appSource from '../src/App.vue?raw';
import homeSource from '../src/routes/HomeView.vue?raw';

const auth = reactive({ isLoggedIn: false });
const progress = reactive({
  attemptUploadStatus: { state: 'idle' as string, pendingCount: 0 },
  syncStatus: { state: 'idle' as string },
});
vi.mock('../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../src/stores/progress.js', () => ({ useProgressStore: () => progress }));

const { useSyncIndicator } = await import('../src/composables/useSyncIndicator.js');

describe('sync indicator', () => {
  it('reads guest, upload and archive state with one precedence', () => {
    const sync = useSyncIndicator();
    expect(sync.value).toMatchObject({ label: 'Gast', tone: 'muted' });

    auth.isLoggedIn = true;
    expect(sync.value).toMatchObject({ label: 'Cloud aktiv', tone: 'ok' });
    progress.syncStatus = { state: 'synced' };
    expect(sync.value).toMatchObject({ label: 'Synchronisiert', tone: 'ok', busy: false });
    progress.syncStatus = { state: 'syncing' };
    expect(sync.value).toMatchObject({ tone: 'busy', busy: true });
    progress.syncStatus = { state: 'conflict' };
    expect(sync.value).toMatchObject({ label: 'Konflikt', tone: 'warn' });
    progress.syncStatus = { state: 'error' };
    expect(sync.value).toMatchObject({ label: 'Synchronisierung fehlgeschlagen', tone: 'error' });
    progress.syncStatus = { state: 'offline' };
    expect(sync.value).toMatchObject({ label: 'Offline', tone: 'muted' });

    // An answer upload outranks the archive: "synced" must not hide pending history.
    progress.syncStatus = { state: 'synced' };
    progress.attemptUploadStatus = { state: 'pending', pendingCount: 2 };
    expect(sync.value).toMatchObject({ label: 'Upload ausstehend', tone: 'warn' });
    progress.attemptUploadStatus = { state: 'error', pendingCount: 1 };
    expect(sync.value).toMatchObject({ label: 'Upload fehlgeschlagen', tone: 'error' });
    progress.attemptUploadStatus = { state: 'uploading', pendingCount: 1 };
    expect(sync.value).toMatchObject({ tone: 'busy', busy: true });
  });

  it('is the only sync wording in the sidebar and drives the phone status pill', () => {
    expect(appSource).toContain('useSyncIndicator()');
    expect(appSource).not.toMatch(/'[✓⟳⚠] /);
    expect(homeSource).toContain('useSyncIndicator()');
    expect(homeSource).toMatch(/class="home__status"[\s\S]*?@click="openAccount"/);
    // Phones only — from 900px the sidebar carries the same reading.
    expect(homeSource).toMatch(/@media \(max-width: 899px\) \{\s*\.home__status \{ display: inline-flex; \}/);
  });
});
