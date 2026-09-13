import { onBeforeUnmount, ref } from 'vue';
import { errorText, type ManagementClient } from './api.js';
/** New reads replace old reads. Writes are never retried or cancelled implicitly. */
export function useRequest(client: ManagementClient, sessionLost: () => void) {
  const busy = ref(false), writing = ref(false), error = ref(''), notice = ref('');
  let generation = 0, disposed = false, controller: AbortController | undefined;
  function cancel() { if (writing.value) return; generation++; controller?.abort(); busy.value = false; }
  async function run<T>(work: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void, mutation = false): Promise<boolean> {
    if (writing.value || disposed) return false;
    cancel();
    const current = ++generation;
    controller = new AbortController();
    busy.value = true; writing.value = mutation; error.value = ''; notice.value = '';
    try {
      const value = await work(controller.signal);
      if (disposed || current !== generation) return false;
      apply(value); return true;
    } catch (caught) {
      if (disposed || current !== generation) return false;
      error.value = errorText(caught);
      if (!client.session) sessionLost();
      return false;
    } finally { if (!disposed && current === generation) { busy.value = false; writing.value = false; } }
  }
  onBeforeUnmount(() => { disposed = true; generation++; if (!writing.value) controller?.abort(); error.value = ''; notice.value = ''; });
  return { busy, writing, error, notice, run, cancel };
}
