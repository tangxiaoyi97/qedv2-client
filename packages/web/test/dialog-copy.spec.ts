import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App, type Component } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ArchiveChoiceDialog from '../src/routes/ArchiveChoiceDialog.vue';
import ConflictDialog from '../src/routes/ConflictDialog.vue';
import { useProgressStore } from '../src/stores/progress.js';

let mounted: { app: App; host: HTMLElement } | undefined;

function mountDialog(component: Component, pinia: ReturnType<typeof createPinia>): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(component);
  app.use(pinia);
  app.mount(host);
  mounted = { app, host };
}

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('data choice dialog copy', () => {
  it('keeps archive choices concise without hiding overwrite consequences', () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const progress = useProgressStore(pinia);
    progress.archiveChoice = {
      serverState: {
        archiveVersion: 2,
        checksum: 'server-checksum',
        updatedAt: '2026-08-09T08:00:00.000Z',
        perPart: [],
        perCompetency: [],
      },
      server: { parts: 4, competencies: 2, lastUpdated: '2026-08-09T08:00:00.000Z' },
      local: { parts: 3, competencies: 2, lastUpdated: '2026-08-09T09:00:00.000Z' },
    };

    mountDialog(ArchiveChoiceDialog, pinia);

    const visible = document.body.textContent ?? '';
    expect(visible).toContain('Konto und Gerät enthalten unterschiedliche Stände.');
    expect(visible).toContain('Empfohlen · neuere Einträge zusammenführen.');
    expect(visible).toContain('Der lokale Stand dieses Geräts wird überschrieben.');
    expect(visible).toContain('Der Cloud-Stand wird überschrieben.');
    expect(visible).not.toContain('diese Frage kommt nur direkt nach der Anmeldung');
  });

  it('states the conflict consequence once and uses a short neutral comparison', () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const progress = useProgressStore(pinia);
    progress.conflict = {
      result: 'conflict',
      serverVersion: 3,
      serverChecksum: 'server-checksum',
      autoMergeable: { perPart: [], perCompetency: [] },
      conflicts: [{
        competencyCode: 'AG 1.1',
        server: { code: 'AG 1.1', mastery: 0.8, updatedAt: '2026-08-09T10:00:00.000Z' },
        local: { code: 'AG 1.1', mastery: 0.6, updatedAt: '2026-08-09T09:00:00.000Z' },
      }],
    };

    mountDialog(ConflictDialog, pinia);

    const visible = document.body.textContent ?? '';
    expect(visible).toContain(
      'Cloud und Gerät enthalten unterschiedliche Änderungen. Eine Version wird überschrieben.',
    );
    expect(visible).toContain('Cloud ist neuer');
    expect(visible).toContain('Einzeln wählen');
    expect(visible).not.toContain('meist die sichere Wahl');
    expect(visible).not.toContain('Pro Eintrag auswählen (erweitert)');
  });
});
