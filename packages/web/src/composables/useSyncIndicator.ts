import { computed, type Component } from 'vue';
import { AlertTriangle, CloudCheck, CloudOff, CloudUpload, RefreshCw, UserCircle } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth.js';
import { useProgressStore } from '../stores/progress.js';

export type SyncTone = 'ok' | 'busy' | 'warn' | 'error' | 'muted';

export interface SyncIndicator {
  /** Untranslated message key — callers run it through their own `t`. */
  label: string;
  tone: SyncTone;
  icon: Component;
  /** True while work is in flight; drives the spinning glyph. */
  busy: boolean;
}

/**
 * One reading of "where is my data" for every surface that shows it.
 *
 * The desktop sidebar spelled the state out with ✓/⟳/⚠ glyphs baked into the
 * strings, and the phone layout — which has no sidebar — showed nothing at
 * all. Both now read this, so the wording, the colour and the precedence
 * (attempt upload first, then archive sync) can no longer drift apart.
 */
export function useSyncIndicator() {
  const auth = useAuthStore();
  const progress = useProgressStore();

  return computed<SyncIndicator>(() => {
    if (!auth.isLoggedIn) return { label: 'Gast', tone: 'muted', icon: UserCircle, busy: false };
    const upload = progress.attemptUploadStatus.state;
    if (upload === 'uploading') return { label: 'Synchronisiert …', tone: 'busy', icon: RefreshCw, busy: true };
    if (upload === 'pending') return { label: 'Upload ausstehend', tone: 'warn', icon: CloudUpload, busy: false };
    if (upload === 'error') return { label: 'Upload fehlgeschlagen', tone: 'error', icon: AlertTriangle, busy: false };
    switch (progress.syncStatus.state) {
      case 'synced':
        return { label: 'Synchronisiert', tone: 'ok', icon: CloudCheck, busy: false };
      case 'syncing':
        return { label: 'Synchronisiert …', tone: 'busy', icon: RefreshCw, busy: true };
      case 'offline':
        return { label: 'Offline', tone: 'muted', icon: CloudOff, busy: false };
      case 'conflict':
        return { label: 'Konflikt', tone: 'warn', icon: AlertTriangle, busy: false };
      case 'error':
        return { label: 'Synchronisierung fehlgeschlagen', tone: 'error', icon: AlertTriangle, busy: false };
      default:
        return { label: 'Cloud aktiv', tone: 'ok', icon: CloudCheck, busy: false };
    }
  });
}
