import { describe, expect, it, vi } from 'vitest';
import type { NetworkPort } from '@qed2/core-logic';
import { installCloudRecovery } from '../src/platform/cloud-recovery.js';

function networkPort() {
  const changes = new Set<(online: boolean) => void>();
  const resumes = new Set<(online: boolean) => void>();
  const network: NetworkPort = {
    isOnline: () => true,
    onChange: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
    onResume: (listener) => { resumes.add(listener); return () => { resumes.delete(listener); }; },
  };
  return { network, changes, resumes };
}

describe('cloud recovery lifecycle', () => {
  it('recovers saved work at boot and on a native wake without a connection change', () => {
    const { network, changes, resumes } = networkPort();
    const progress = { scheduleCloudRecovery: vi.fn() };
    installCloudRecovery(network, { isLoggedIn: true }, progress);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledExactlyOnceWith(true);

    for (const listener of resumes) listener(true);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledTimes(2);
    for (const listener of changes) listener(false);
    for (const listener of resumes) listener(false);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledTimes(2);
    for (const listener of changes) listener(true);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledTimes(3);
  });

  it('does not recover guest work, reads current authentication and detaches on shutdown', () => {
    const { network, changes, resumes } = networkPort();
    const auth = { isLoggedIn: false };
    const progress = { scheduleCloudRecovery: vi.fn() };
    const dispose = installCloudRecovery(network, auth, progress);
    for (const listener of resumes) listener(true);
    expect(progress.scheduleCloudRecovery).not.toHaveBeenCalled();
    auth.isLoggedIn = true;
    for (const listener of changes) listener(true);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledTimes(1);
    const pendingNotification = [...resumes][0]!;
    dispose();
    pendingNotification(true);
    expect(changes.size).toBe(0);
    expect(resumes.size).toBe(0);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledTimes(1);
  });

  it('keeps browser ports compatible when there is no native wake capability', () => {
    const { network, changes } = networkPort();
    delete network.onResume;
    const progress = { scheduleCloudRecovery: vi.fn() };
    const dispose = installCloudRecovery(network, { isLoggedIn: true }, progress);
    for (const listener of changes) listener(true);
    expect(progress.scheduleCloudRecovery).toHaveBeenCalledTimes(2);
    expect(dispose).not.toThrow();
    expect(changes.size).toBe(0);
  });
});
