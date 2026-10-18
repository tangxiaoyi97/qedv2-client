import { describe, expect, it } from 'vitest';
import { desktopReleaseIdentity } from '../src/main/release-channel.js';

describe('desktop release isolation', () => {
  it('keeps preview storage identity, sessions and operating-system app ID separate', () => {
    const stable = desktopReleaseIdentity('stable');
    const preview = desktopReleaseIdentity('preview');
    expect(preview.name).not.toBe(stable.name);
    expect(preview.appId).not.toBe(stable.appId);
    expect(preview.sessionPartition).not.toBe(stable.sessionPartition);
    expect(preview.selfUpdate).toBe(false);
    expect(stable.selfUpdate).toBe(true);
  });
});
