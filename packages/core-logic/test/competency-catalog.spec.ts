import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCompetencyCatalog } from '../src/api/competency-catalog.js';
import { CoreClient } from '../src/api/core-client.js';
import { ApiError, CoreProtocolError, NetworkError } from '../src/api/types.js';
import { lookupCompetency, normalizeCompetencyCode, type CompetencyCatalog, type CompetencyLocale } from '../src/model/competency-catalog.js';
import { competencyCatalogFixture } from './fixtures/competency-catalog.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('competency catalog contract', () => {
  it('preserves future document versions, math, source pages, contexts and effective dates without sharing wire objects', () => {
    const wire = competencyCatalogFixture('en');
    wire.version = '2027-05';
    const parsed = parseCompetencyCatalog(wire, 'en');
    expect(parsed).toEqual(wire);
    expect(parsed).not.toBe(wire);
    expect(parsed.areas[0]!.groups[0]!.competencies[0]).not.toBe(wire.areas[0]!.groups[0]!.competencies[0]);
    expect(lookupCompetency(parsed, 'WS3.4')?.footnotes[0]?.effectiveFrom?.date).toBe('2027-05');
  });

  it('normalizes known compact codes but refuses guessed, partial or malformed codes', () => {
    expect(normalizeCompetencyCode(' an 1.1 ')).toBe('AN 1.1');
    expect(normalizeCompetencyCode('AG1.1')).toBe('AG 1.1');
    for (const value of ['AG', 'AG 01.1', 'AN1.0', 'AG 1.1 extra', 'XX1.1', '../AG1.1']) {
      expect(normalizeCompetencyCode(value)).toBeNull();
    }
    expect(lookupCompetency(competencyCatalogFixture(), 'AN 8.1')).toBeNull();
  });

  it('keeps group comments and code-specific comments separate and never lends a footnote to a neighbour', () => {
    const catalog = parseCompetencyCatalog(competencyCatalogFixture());
    expect(lookupCompetency(catalog, 'WS1.1')?.comments.map((x) => x.text)).toEqual(['Only WS 1.1', 'Group comment WS 1']);
    expect(lookupCompetency(catalog, 'WS1.2')?.comments.map((x) => x.text)).toEqual(['Group comment WS 1']);
    expect(lookupCompetency(catalog, 'WS2.3')?.comments.map((x) => x.text)).toEqual(['Only WS 2.3']);
    expect(lookupCompetency(catalog, 'WS2.4')?.comments).toEqual([]);
    expect(lookupCompetency(catalog, 'FA1.2')?.footnotes).toEqual([]);
    expect(lookupCompetency(catalog, 'WS3.5')?.footnotes.map((x) => x.marker)).toEqual(['**']);
  });

  const corruptions: [string, (wire: CompetencyCatalog) => void][] = [
    ['duplicate areas', (wire) => { wire.areas[1] = wire.areas[0]!; }],
    ['duplicate groups', (wire) => { wire.areas[0]!.groups.push(wire.areas[0]!.groups[0]!); }],
    ['duplicate definitions', (wire) => { const g = wire.areas[0]!.groups[0]!; g.competencies.push(g.competencies[0]!); }],
    ['definition in wrong group', (wire) => { wire.areas[0]!.groups[0]!.competencies[0]!.code = 'AN 1.1'; }],
    ['unresolved footnote', (wire) => { wire.areas[0]!.groups[0]!.competencies[0]!.footnoteRefs = ['*']; }],
    ['footnote assigned to neighbour', (wire) => { wire.areas[1]!.groups[0]!.footnotes[0]!.competencyCodes = ['FA 1.2']; }],
    ['comment assigned to another group', (wire) => { wire.areas[3]!.groups[0]!.comments[0]!.competencyCodes = ['WS 2.3']; }],
    ['empty scope becoming group-wide', (wire) => { wire.areas[3]!.groups[0]!.comments[0]!.competencyCodes = []; }],
    ['out-of-document page', (wire) => { wire.areas[0]!.groups[0]!.competencies[0]!.pages = [16]; }],
    ['malformed effective date', (wire) => { wire.areas[3]!.groups[2]!.footnotes[0]!.effectiveFrom!.date = '2027-99'; }],
    ['executable source URL', (wire) => { wire.source.url = 'javascript:alert(1)'; }],
    ['credentials in source URL', (wire) => { wire.source.url = 'https://secret:password@example.test'; }],
    ['oversized text', (wire) => { wire.title = 'x'.repeat(32_001); }],
    ['empty title', (wire) => { wire.title = ' '; }],
    ['oversized list', (wire) => { wire.areas[0]!.introduction = Array.from({ length: 129 }, () => ({ text: 'a', pages: [1] })); }],
    ['text budget exceeded', (wire) => { wire.areas[0]!.introduction = Array.from({ length: 64 }, () => ({ text: 'x'.repeat(32_000), pages: [1] })); }],
    ['inconsistent table widths', (wire) => { const b = wire.contexts.blocks[3]!; if (b.type === 'table') b.rows.push(['only one cell']); }],
  ];
  it.each(corruptions)('rejects %s instead of displaying partial data', (_name, corrupt) => {
    const wire = competencyCatalogFixture();
    corrupt(wire);
    expect(() => parseCompetencyCatalog(wire)).toThrow(CoreProtocolError);
  });

  it('rejects unsupported schema, unexpected language, empty responses and unsafe object prototypes', () => {
    expect(() => parseCompetencyCatalog({ ...competencyCatalogFixture(), schemaVersion: 2 })).toThrow(CoreProtocolError);
    expect(() => parseCompetencyCatalog(competencyCatalogFixture('en'), 'de')).toThrow(CoreProtocolError);
    expect(() => parseCompetencyCatalog(null)).toThrow(CoreProtocolError);
    expect(() => parseCompetencyCatalog(Object.create(competencyCatalogFixture()))).toThrow(CoreProtocolError);
  });
});

describe('CoreClient competency catalogs', () => {
  function respond(status: number, body: unknown) {
    const fetch = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, statusText: 'test', text: async () => JSON.stringify(body) });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('requests the selected language anonymously and validates the payload', async () => {
    const wire = competencyCatalogFixture('en');
    const fetch = respond(200, wire);
    expect(await new CoreClient('https://core.test/prefix/').getCompetencyCatalog('en')).toEqual(wire);
    expect(fetch).toHaveBeenCalledWith('https://core.test/prefix/content/competencies/en', expect.objectContaining({
      method: 'GET', credentials: 'omit', headers: {}, signal: expect.anything(),
    }));
  });

  it('treats only HTTP 404 as a compatible missing catalog', async () => {
    const client = new CoreClient('https://core.test');
    respond(404, { error: { code: 'NOT_FOUND', message: 'old core' } });
    expect(await client.getCompetencyCatalog('de')).toBeNull();
    respond(503, {});
    await expect(client.getCompetencyCatalog('de')).rejects.toBeInstanceOf(ApiError);
    respond(200, { error: 'broken data' });
    await expect(client.getCompetencyCatalog('de')).rejects.toBeInstanceOf(CoreProtocolError);
    respond(200, competencyCatalogFixture('en'));
    await expect(client.getCompetencyCatalog('de')).rejects.toBeInstanceOf(CoreProtocolError);
  });

  it('rejects unsupported language before making a request', async () => {
    const fetch = respond(200, {});
    await expect(new CoreClient('https://core.test').getCompetencyCatalog('../info' as CompetencyLocale)).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('has a finite ten-second deadline and exposes offline/timeout failures', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const result = new CoreClient('https://core.test').getCompetencyCatalog('de').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(NetworkError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(new CoreClient('https://core.test').getCompetencyCatalog('de')).rejects.toBeInstanceOf(NetworkError);
  });
});
