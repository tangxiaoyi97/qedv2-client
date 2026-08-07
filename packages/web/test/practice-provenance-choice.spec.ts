import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PracticeView from '../src/routes/PracticeView.vue';
import { usePracticeStore } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

describe('Practice legacy provenance choice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('labels the unknown version and requires the explicit current-bank action', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    await useProgressStore().init();
    const practice = usePracticeStore();
    vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
    const resume = vi.spyOn(practice, 'resumeWithCurrentContent').mockResolvedValue();
    practice.$patch({ phase: 'provenance-choice' });

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
    await nextTick();

    expect(host.textContent).toContain('Aufgabenversion unbekannt');
    expect(host.textContent).toContain('nicht automatisch mit neueren Aufgaben vermischt');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.includes('Aktuelle Aufgabenbank verwenden'));
    expect(button).toBeDefined();
    button!.click();
    await nextTick();
    expect(resume).toHaveBeenCalledOnce();

    app.unmount();
  });
});
