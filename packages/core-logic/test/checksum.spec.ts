import { describe, expect, it } from 'vitest';
import {
  EMPTY_ARCHIVE_CHECKSUM,
  archiveChecksum,
  canonicalArchiveString,
  stableStringify,
} from '../src/sync/index.js';
import type { ArchiveContent } from '../src/model/archive.js';
import vectors from './fixtures/checksum-vectors.json';

interface Vector {
  name: string;
  content: ArchiveContent;
  checksum: string;
  canonical: string;
}

describe('checksum vectors (generated from the real server implementation)', () => {
  for (const vector of vectors as Vector[]) {
    it(`matches canonical string and checksum for "${vector.name}"`, () => {
      expect(canonicalArchiveString(vector.content)).toBe(vector.canonical);
      expect(archiveChecksum(vector.content)).toBe(vector.checksum);
    });
  }

  it('EMPTY_ARCHIVE_CHECKSUM equals the verified empty-archive vector', () => {
    const empty = (vectors as Vector[]).find((v) => v.name === 'empty');
    expect(empty).toBeDefined();
    expect(EMPTY_ARCHIVE_CHECKSUM).toBe(empty!.checksum);
    expect(EMPTY_ARCHIVE_CHECKSUM).toBe(
      '389e57af4fe5f0cea96241a5916185940cd3d1b7e66a5983e13f6c2c30b857be',
    );
  });

  it('sorts deliberately-unsorted input arrays (vector 2)', () => {
    const unsorted = (vectors as Vector[]).find((v) => v.name === 'two-parts-unsorted-input')!;
    // Input order: 2023-… before 2019-…, "FA 1.5" before "AN 4.3" — canonical
    // output must be sorted regardless.
    expect(unsorted.content.perPart[0]!.partId > unsorted.content.perPart[1]!.partId).toBe(true);
    const canonical = canonicalArchiveString(unsorted.content);
    expect(canonical.indexOf('2019-ht-t1-02-a')).toBeLessThan(canonical.indexOf('2023-ht-t1-09-a'));
    expect(canonical.indexOf('AN 4.3')).toBeLessThan(canonical.indexOf('FA 1.5'));
  });
});

describe('optional-field omission semantics', () => {
  const base: ArchiveContent = {
    perPart: [
      {
        partId: 'p1',
        fsrs: { due: '2026-07-04T00:00:00.000Z', stability: 1, difficulty: 5, reps: 1, lapses: 0 },
        updatedAt: '2026-07-03T08:30:00.000Z',
      },
    ],
    perCompetency: [],
  };

  it('a present-but-undefined lastReview key hashes identically to an absent key', () => {
    // exactOptionalPropertyTypes forbids literal `lastReview: undefined`, but
    // runtime data (e.g. from deserialization layers) can carry it — the
    // stable stringify must drop undefined-valued keys like the server does.
    const withUndefined = {
      perPart: [
        {
          partId: 'p1',
          fsrs: {
            due: '2026-07-04T00:00:00.000Z',
            stability: 1,
            difficulty: 5,
            reps: 1,
            lapses: 0,
            lastReview: undefined,
          },
          lastResult: undefined,
          updatedAt: '2026-07-03T08:30:00.000Z',
        },
      ],
      perCompetency: [],
    } as unknown as ArchiveContent;
    expect(canonicalArchiveString(withUndefined)).toBe(canonicalArchiveString(base));
    expect(archiveChecksum(withUndefined)).toBe(archiveChecksum(base));
    expect(canonicalArchiveString(base)).not.toContain('lastReview');
    expect(canonicalArchiveString(base)).not.toContain('null');
  });

  it('stableStringify drops undefined-valued keys but keeps null', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify({ a: null })).toBe('{"a":null}');
  });
});

describe('timestamp normalization', () => {
  it('normalizes non-canonical timezone offsets to ISO UTC ms precision', () => {
    const offsetContent: ArchiveContent = {
      perPart: [
        {
          partId: 'p1',
          fsrs: {
            due: '2026-01-01T00:00:00+02:00',
            stability: 1,
            difficulty: 5,
            reps: 1,
            lapses: 0,
            lastReview: '2025-12-31T23:00:00+01:00',
          },
          updatedAt: '2026-01-01T02:00:00+02:00',
        },
      ],
      perCompetency: [{ code: 'AG 1.1', mastery: 0.5, updatedAt: '2026-01-01T00:00:00+02:00' }],
    };
    const normalizedContent: ArchiveContent = {
      perPart: [
        {
          partId: 'p1',
          fsrs: {
            due: '2025-12-31T22:00:00.000Z',
            stability: 1,
            difficulty: 5,
            reps: 1,
            lapses: 0,
            lastReview: '2025-12-31T22:00:00.000Z',
          },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      perCompetency: [{ code: 'AG 1.1', mastery: 0.5, updatedAt: '2025-12-31T22:00:00.000Z' }],
    };
    const canonical = canonicalArchiveString(offsetContent);
    expect(canonical).toContain('2025-12-31T22:00:00.000Z');
    expect(canonical).not.toContain('+02:00');
    expect(canonical).toBe(canonicalArchiveString(normalizedContent));
    expect(archiveChecksum(offsetContent)).toBe(archiveChecksum(normalizedContent));
  });
});

describe('unicode handling', () => {
  it('sorts unicode object keys by code point and encodes like JSON.stringify', () => {
    const value = { 'ü': 1, 'a': 2, 'ß': 3, 'Z': 4 };
    // Code point order: 'Z' (0x5A) < 'a' (0x61) < 'ß' (0xDF) < 'ü' (0xFC).
    expect(stableStringify(value)).toBe('{"Z":4,"a":2,"ß":3,"ü":1}');
    expect(stableStringify('ä✓')).toBe(JSON.stringify('ä✓'));
  });

  it('handles unicode part ids in content (vector 3 has "x-ä-1")', () => {
    const v3 = (vectors as Vector[]).find((v) => v.name === 'floats-umlaut-halfpoints')!;
    expect(canonicalArchiveString(v3.content)).toContain('x-ä-1');
    expect(archiveChecksum(v3.content)).toBe(v3.checksum);
  });
});
