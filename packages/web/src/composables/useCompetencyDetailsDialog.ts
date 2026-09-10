import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import { uiLocale } from '@qed2/ui';
import type { CompetencyCatalog, CompetencyLocale, CoreClient } from '@qed2/core-logic';
import { useCompetencyCatalogStore } from '../stores/competencies.js';

export interface CompetencyDialogSource {
  baseUrl: string;
  client: CoreClient;
}

/** The dialog is separate from the practice player and never changes its draft. */
export function useCompetencyDetailsDialog(source: () => CompetencyDialogSource) {
  const store = useCompetencyCatalogStore();
  const isOpen = ref(false);
  const code = ref('');
  const fallbackDescription = ref<string>();
  const locale = ref<CompetencyLocale>(uiLocale.value);
  const catalog = shallowRef<CompetencyCatalog | null>(null);
  const loading = ref(false);
  const error = ref(false);
  let generation = 0;

  async function load(force = false): Promise<void> {
    const requestGeneration = ++generation;
    const selectedSource = source();
    const selectedLocale = locale.value;
    const ownsResult = () => requestGeneration === generation && isOpen.value
      && source().baseUrl === selectedSource.baseUrl && locale.value === selectedLocale;
    loading.value = true;
    error.value = false;
    catalog.value = null;
    try {
      const result = await store.load(selectedSource, selectedLocale, force);
      if (ownsResult()) catalog.value = result;
    } catch {
      if (ownsResult()) error.value = true;
    } finally {
      if (ownsResult()) loading.value = false;
    }
  }

  function open(request: { code: string; description?: string }): void {
    code.value = request.code;
    fallbackDescription.value = request.description;
    locale.value = uiLocale.value;
    isOpen.value = true;
    void load();
  }

  function close(): void {
    generation++;
    isOpen.value = false;
    loading.value = false;
  }

  function changeLocale(next: CompetencyLocale): void {
    if (next === locale.value || !isOpen.value) return;
    locale.value = next;
    void load();
  }

  watch(() => source().baseUrl, () => { if (isOpen.value) void load(); });
  onScopeDispose(close);

  return { isOpen, code, fallbackDescription, locale, catalog, loading, error, open, close, changeLocale, retry: () => isOpen.value ? load(true) : Promise.resolve() };
}
