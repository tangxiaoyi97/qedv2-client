import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question, ShellPort } from '@qed2/core-logic';
import PracticeView from '../src/routes/PracticeView.vue';
import { ports } from '../src/services.js';
import { usePracticeStore } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

const COMMIT = 'ff304623607463386026ebeebdbc17a576db1925';
const originalShell = ports.shell;

function question(id: string, nr: number): Question {
  return {
    id,
    schemaVersion: 3,
    status: 'reviewed',
    lang: 'de',
    source: {
      suite: 'srdp',
      year: 2026,
      term: 'haupttermin',
      part: 't1',
      nr,
      file: `${id}.pdf`,
    },
    title: `Aufgabe ${nr}`,
    playable: true,
    parts: [
      {
        id: `${id}-a`,
        label: 'a',
        competencies: [{ code: 'AG 1.1' }],
        answer: {
          kind: 'choice',
          options: [
            [{ t: 'text', v: 'richtig' }],
            [{ t: 'text', v: 'falsch' }],
          ],
          correct: [0],
          selectCount: 1,
        },
        scoring: { mode: 'allOrNothing', points: 1 },
        points: 1,
      },
    ],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountPractice(options: {
  shell: ShellPort;
  source: 'local' | 'remote';
  mode: 'current' | 'revision';
  count?: 1 | 2;
  phase?: 'running' | 'summary';
}): Promise<{ host: HTMLElement; unmount: () => void }> {
  ports.shell = options.shell;
  const pinia = createPinia();
  setActivePinia(pinia);
  await useProgressStore().init();
  const practice = usePracticeStore();
  vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
  const questions = [question('q1', 1), question('q2', 2)].slice(0, options.count ?? 2);
  practice.$patch((state) => {
    state.phase = options.phase ?? 'running';
    state.items = questions.map((entry) => ({
      questionId: entry.id,
      partId: entry.parts[0]!.id,
      reason: 'manual',
    }));
    state.questions = new Map(questions.map((entry) => [entry.id, entry]));
    state.contentSource = options.source;
    state.contentId = COMMIT;
    state.contentMode = options.mode;
    state.graded = options.phase === 'summary'
      ? [{
          clientAttemptId: 'attempt-1',
          partId: questions[0]!.parts[0]!.id,
          questionId: questions[0]!.id,
          result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
          reason: 'manual',
          gradedAt: '2026-08-08T00:00:00.000Z',
          elapsedMs: 1000,
        }]
      : [];
  });

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/practice', component: PracticeView },
      { path: '/', component: { template: '<div />' } },
    ],
  });
  await router.push('/practice');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(PracticeView);
  app.use(pinia);
  app.use(router);
  app.mount(host);
  await settle();
  return { host, unmount: () => app.unmount() };
}

describe('practice question-bank footer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    ports.shell = originalShell;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('moves the Web provenance out of the top bar and into both programme-list footers', async () => {
    const mounted = await mountPractice({ shell: originalShell, source: 'remote', mode: 'current' });

    expect(mounted.host.querySelector('.practice__topbar .practice__source-footer')).toBeNull();
    expect(mounted.host.querySelector('.practice__topbar')?.textContent).not.toContain('Remote-Core');

    const railFooter = mounted.host.querySelector<HTMLElement>(
      '.practice__session-rail-shell .practice__source-footer',
    );
    expect(railFooter?.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe(
      'Remote-Core · ff30462',
    );
    expect(railFooter?.title).toBe(`Remote-Core · ${COMMIT}`);
    expect(railFooter?.querySelector('.practice__visually-hidden')?.textContent).toBe(
      `Remote-Core. Revision ${COMMIT}`,
    );

    mounted.host.querySelector<HTMLButtonElement>('.practice__session-button')?.click();
    await settle();
    const drawerFooter = document.querySelector<HTMLElement>(
      '.practice-session-drawer__panel .practice__source-footer--drawer',
    );
    expect(drawerFooter?.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe(
      'Remote-Core · ff30462',
    );
    expect(drawerFooter?.title).toBe(`Remote-Core · ${COMMIT}`);
    expect(drawerFooter?.querySelector('.practice__visually-hidden')?.textContent).toBe(
      `Remote-Core. Revision ${COMMIT}`,
    );
    mounted.unmount();
  });

  it('keeps the Remote-Core label in Desktop remote mode', async () => {
    const desktopShell: ShellPort = {
      capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
      onCommand: () => () => undefined,
    };
    const mounted = await mountPractice({
      shell: desktopShell,
      source: 'remote',
      mode: 'current',
    });

    const footer = mounted.host.querySelector<HTMLElement>('.practice__source-footer');
    expect(footer?.dataset.source).toBe('remote');
    expect(footer?.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe(
      'Remote-Core · ff30462',
    );
    mounted.unmount();
  });

  it('keeps provenance visible for a single question and on the summary', async () => {
    const single = await mountPractice({
      shell: originalShell,
      source: 'remote',
      mode: 'current',
      count: 1,
    });
    expect(single.host.querySelector('.practice__session-rail-shell')).toBeNull();
    expect(single.host.querySelector('.practice__source-footer--inline')?.textContent).toContain(
      'Remote-Core · ff30462',
    );
    single.unmount();
    document.body.innerHTML = '';

    const summary = await mountPractice({
      shell: originalShell,
      source: 'remote',
      mode: 'current',
      count: 1,
      phase: 'summary',
    });
    expect(summary.host.querySelector('.practice__source-footer--summary')?.textContent).toContain(
      'Remote-Core · ff30462',
    );
    summary.unmount();
  });

  it('reveals local provenance and the archive marker only with Desktop capability', async () => {
    const desktopShell: ShellPort = {
      capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
      onCommand: () => () => undefined,
    };
    const mounted = await mountPractice({
      shell: desktopShell,
      source: 'local',
      mode: 'revision',
    });

    const footer = mounted.host.querySelector<HTMLElement>('.practice__source-footer');
    expect(footer?.dataset.source).toBe('local');
    expect(footer?.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe(
      'Lokale Bank · Archiv ff30462',
    );
    expect(footer?.title).toBe(`Lokale Bank · Archiv · ${COMMIT}`);
    expect(footer?.querySelector('.practice__visually-hidden')?.textContent).toBe(
      `Lokale Bank. Archiv. Revision ${COMMIT}`,
    );
    mounted.unmount();
  });
});
