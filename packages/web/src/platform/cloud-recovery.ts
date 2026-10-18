import type { NetworkPort } from '@qed2/core-logic';

/** Connect boot, reconnection and native wake to the same durable recovery loop. */
export function installCloudRecovery(
  network: NetworkPort,
  auth: { readonly isLoggedIn: boolean },
  progress: { scheduleCloudRecovery(immediate?: boolean): void },
): () => void {
  let disposed = false;
  const recover = (online: boolean) => {
    if (!disposed && online && auth.isLoggedIn) progress.scheduleCloudRecovery(true);
  };
  const removeChange = network.onChange(recover);
  const removeResume = network.onResume?.(recover);
  // Restore durable work after a renderer restart, including an expired
  // offline login. The recovery loop owns token refresh, retries and choices.
  if (auth.isLoggedIn) progress.scheduleCloudRecovery(true);
  return () => {
    disposed = true;
    removeChange();
    removeResume?.();
  };
}
