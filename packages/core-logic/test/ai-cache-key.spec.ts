import { describe, expect, it, vi } from 'vitest';
import { aiCacheDigest, deterministicAiRequestId, secureRandomUuidV4 } from '../src/index.js';

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

describe('deterministicAiRequestId', () => {
  const base = {
    interactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
    request: { mode: 'hint', hintLevel: 1, language: 'Deutsch', preferPool: false },
  };

  it('is a stable lowercase UUIDv4 for a logical retry', () => {
    const first = deterministicAiRequestId(base);
    expect(deterministicAiRequestId({ ...base, request: { ...base.request } })).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it.each([
    ['hint level', { ...base, request: { ...base.request, hintLevel: 2 } }],
    ['payer', { ...base, request: { ...base.request, preferPool: true } }],
    ['language', { ...base, request: { ...base.request, language: 'English' } }],
    ['instructions', { ...base, request: { ...base.request, customInstructions: 'kurz' } }],
    ['revision', { ...base, request: { ...base.request, contentId: 'a'.repeat(40) } }],
  ])('changes with %s', (_label, changed) => {
    expect(deterministicAiRequestId(changed)).not.toBe(deterministicAiRequestId(base));
  });
});

describe('secureRandomUuidV4', () => {
  it('uses CSPRNG bytes and emits a strict UUIDv4', () => {
    const id = secureRandomUuidV4();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it('fails closed when Web Crypto is unavailable', () => {
    const previous = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    try {
      expect(() => secureRandomUuidV4()).toThrow('Secure random UUID generation is unavailable');
    } finally {
      vi.stubGlobal('crypto', previous);
    }
  });
});
