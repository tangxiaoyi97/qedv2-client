import { isThemeAppearance, type ThemeAppearance } from '../platform/theme-preferences.js';

/**
 * Read one existing preference from pre-mirror Client installations. This is
 * deliberately independent of WebStorage: no migrations, stores, or progress.
 * Enumeration is required so opening admin never creates a learner database.
 */
export function readLegacyThemeAppearance(timeoutMs = 500): Promise<ThemeAppearance | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let db: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    const finish = (value?: ThemeAppearance): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { transaction?.abort(); } catch { /* Already complete. */ }
      db?.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), timeoutMs);

    void (async () => {
      try {
        const factory = window.indexedDB;
        if (!factory || typeof factory.databases !== 'function') return finish();
        const existing = await factory.databases();
        if (settled) return;
        if (!existing.some((entry) => entry.name === 'qed2' && (entry.version ?? 0) > 0)) {
          return finish();
        }
        // No version argument: never upgrade an existing database.
        const request = factory.open('qed2');
        request.onupgradeneeded = () => {
          // The database may have been deleted after enumeration. Abort its
          // creation, including when this request completes after our timeout.
          request.transaction?.abort();
          finish();
        };
        request.onblocked = () => finish();
        request.onerror = (event) => { event.preventDefault(); finish(); };
        request.onsuccess = () => {
          db = request.result;
          if (settled) { db.close(); return; }
          db.onversionchange = () => finish();
          try {
            if (!db.objectStoreNames.contains('config')) return finish();
            transaction = db.transaction('config', 'readonly');
            const read = transaction.objectStore('config').get('theme');
            let theme: ThemeAppearance | undefined;
            read.onsuccess = () => {
              if (isThemeAppearance(read.result)) theme = read.result;
            };
            transaction.oncomplete = () => finish(theme);
            transaction.onerror = () => finish();
            transaction.onabort = () => finish();
          } catch {
            finish();
          }
        };
      } catch {
        finish();
      }
    })();
  });
}
