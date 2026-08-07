/**
 * Web implementations of the remaining platform ports.
 *
 * - CoreRuntimePort: the web client ALWAYS uses the configured remote core —
 *   contract §8.2: web/PWA never spawns a local core (that is the future
 *   desktop shell's capability; the interface already models it).
 * - UpdatePort: web updates ship with the Pages deployment — version display
 *   only, no self-update.
 * - NetworkPort: navigator.onLine + events.
 * - ShellPort: no native chrome or commands in a browser.
 */
import type {
  CoreEndpoint,
  CoreRuntimePort,
  NetworkPort,
  ShellPort,
  UpdateCheckResult,
  UpdatePort,
} from '@qed2/core-logic';

export class WebCoreRuntime implements CoreRuntimePort {
  readonly capabilities = { localCore: false } as const;

  constructor(private readonly getConfiguredUrl: () => string) {}

  getEndpoint(): Promise<CoreEndpoint> {
    return Promise.resolve({ baseUrl: this.getConfiguredUrl(), source: 'remote' });
  }
}

export class WebUpdate implements UpdatePort {
  readonly capabilities = { selfUpdate: false, manualAppInstall: false } as const;

  constructor(private readonly appVersion: string) {}

  getAppVersion(): string {
    return this.appVersion;
  }

  checkForUpdates(): Promise<UpdateCheckResult[]> {
    return Promise.resolve([
      {
        target: 'app',
        currentVersion: this.appVersion,
        updateAvailable: false,
        detail: 'Web-Version aktualisiert sich automatisch mit dem Deployment.',
      },
    ]);
  }
}

export class WebNetwork implements NetworkPort {
  isOnline(): boolean {
    return typeof navigator === 'undefined' ? true : navigator.onLine;
  }

  onChange(cb: (online: boolean) => void): () => void {
    const on = () => cb(true);
    const off = () => cb(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }
}

/** Browser fallback for the native-shell seam. */
export class WebShell implements ShellPort {
  readonly capabilities = {
    desktop: false,
    nativeMenu: false,
    nativeTitleBar: false,
  } as const;

  onCommand(_cb: Parameters<ShellPort['onCommand']>[0]): () => void {
    return () => undefined;
  }
}
