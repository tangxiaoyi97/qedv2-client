import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from '../src/api/core-client.js';

const CORE = 'http://localhost:8787';

const KNOWN_KINDS = ['choice', 'matching', 'numeric', 'interval', 'expression', 'open'];

describe('CoreClient.search (unit, stubbed fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(body: string): string[] {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(body),
      });
    });
    return urls;
  }

  it('never hits the network for empty/whitespace queries', async () => {
    const urls = stubFetch('{}');
    const client = new CoreClient(CORE);
    expect(await client.search('')).toEqual({ query: '', total: 0, items: [] });
    expect(await client.search('   ')).toEqual({ query: '', total: 0, items: [] });
    expect(urls).toHaveLength(0);
  });

  it('sends trimmed q and limit as query params', async () => {
    const urls = stubFetch(JSON.stringify({ query: 'Dreieck', total: 0, items: [] }));
    const client = new CoreClient(CORE);
    await client.search('  Dreieck ', { limit: 5 });
    expect(urls[0]).toContain('/content/search?');
    expect(urls[0]).toContain('q=Dreieck');
    expect(urls[0]).toContain('limit=5');
  });
});

/* ---------------- live sections (skip when core is down) ---------------- */

// core-logic compiles without DOM/Node libs — platform globals via a
// structurally-typed alias (same pattern as api-integration.spec.ts).
const g = globalThis as unknown as {
  fetch: (url: string, init?: { signal?: unknown }) => Promise<{ ok: boolean }>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  AbortController: new () => { signal: unknown; abort(): void };
};

const coreUp = await (async () => {
  const ctl = new g.AbortController();
  const timer = g.setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await g.fetch(`${CORE}/health`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    g.clearTimeout(timer);
  }
})();

describe.skipIf(!coreUp)('search + t2 regression (live core)', () => {
  const client = new CoreClient(CORE);

  it('ranked fuzzy search with <em> highlights (upgrade doc §6)', async () => {
    const res = await client.search('Dreieck', { limit: 5 });
    expect(res.total).toBeGreaterThan(0);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.length).toBeLessThanOrEqual(5);
    const first = res.items[0]!;
    expect(first.id).toBeTruthy();
    expect(first.matchedFields.length).toBeGreaterThan(0);
    expect(first.highlights.some((h) => h.snippet.includes('<em>'))).toBe(true);
    // fuzzy: a small typo still hits
    const fuzzy = await client.search('Dreieik', { limit: 5 });
    expect(fuzzy.total).toBeGreaterThan(0);
  });

  it('regression: 2025-ht-t2-01 loads and every part is answerable', async () => {
    // "t2 questions would not open" — root-caused to core being down at the
    // time; this pins the client-visible contract: batch fetch resolves the
    // question, it is playable, and every part carries a known answer kind.
    const res = await client.getQuestionsBatch(['2025-ht-t2-01']);
    expect(res.missing).toEqual([]);
    const q = res.questions[0]!;
    expect(q.playable).toBe(true);
    expect(q.parts.length).toBeGreaterThan(0);
    for (const part of q.parts) {
      expect(part.answer, `part ${part.id} must be answerable`).toBeDefined();
      expect(KNOWN_KINDS).toContain(part.answer!.kind);
    }
  });
});
