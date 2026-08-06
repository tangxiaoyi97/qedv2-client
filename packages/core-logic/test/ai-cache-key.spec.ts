import { describe, expect, it } from 'vitest';
import { aiCacheDigest } from '../src/index.js';

describe('aiCacheDigest', () => {
  it('is deterministic, order-stable and contains no request material', () => {
    const a = aiCacheDigest({ submitted: 'mein geheimer Rechenweg', mode: 'answer' });
    const b = aiCacheDigest({ mode: 'answer', submitted: 'mein geheimer Rechenweg' });
    expect(a).toBe(b);
    expect(a).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(a).not.toContain('geheimer');
  });

  it('changes when account or server scope changes', () => {
    const request = { partId: 'p', submitted: 'x' };
    expect(aiCacheDigest({ user: 'u1', server: 'a', request })).not.toBe(
      aiCacheDigest({ user: 'u2', server: 'a', request }),
    );
    expect(aiCacheDigest({ user: 'u1', server: 'a', request })).not.toBe(
      aiCacheDigest({ user: 'u1', server: 'b', request }),
    );
  });
});
