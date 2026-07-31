import { describe, it, expect } from 'vitest';
import { entriesToAnnounce, parseChangelogIndex, type ChangelogEntry } from '../src/changelog.js';
import {
  parseChangelog,
  normalizeDraft,
  prependSection,
  isPrerelease,
} from '../../../scripts/changelog.mjs';
// Through Vite rather than node:fs — this package types only against
// vite/client (see pwa-manifest.spec.ts). Importing the real file means a
// hand-edit that breaks the format fails the suite, not a deploy.
import CHANGELOG from '../../../CHANGELOG.md?raw';

const entry = (version: string, date = '2026-01-01'): ChangelogEntry => ({
  version,
  date,
  body: `notes for ${version}`,
});

/** Newest first, as CHANGELOG.md is written and the build preserves. */
const INDEX = [entry('1.9.7'), entry('1.9.6'), entry('1.9.5'), entry('1.9.0')];

describe('entriesToAnnounce', () => {
  it('says nothing on a fresh install', () => {
    expect(entriesToAnnounce(INDEX, '1.9.7', null)).toEqual([]);
  });

  it('says nothing when the running version was already seen', () => {
    expect(entriesToAnnounce(INDEX, '1.9.7', '1.9.7')).toEqual([]);
  });

  it('announces every version skipped, not just the newest', () => {
    // The failure this exists for: updating from 1.9.5 straight to 1.9.7 used
    // to show 1.9.7's notes only, and 1.9.6's were unreachable forever.
    const shown = entriesToAnnounce(INDEX, '1.9.7', '1.9.5');
    expect(shown.map((e) => e.version)).toEqual(['1.9.7', '1.9.6']);
  });

  it('announces only the current version when the last seen one is unknown', () => {
    // Migrating off the old commit-keyed marker lands here — it must not dump
    // the entire history on someone who has been using the app all along.
    expect(entriesToAnnounce(INDEX, '1.9.7', '').map((e) => e.version)).toEqual(['1.9.7']);
    expect(entriesToAnnounce(INDEX, '1.9.7', '0.1.0').map((e) => e.version)).toEqual(['1.9.7']);
  });

  it('stays quiet on a rollback', () => {
    expect(entriesToAnnounce(INDEX, '1.9.5', '1.9.7')).toEqual([]);
  });

  it('stays quiet when this build has no section (a beta)', () => {
    expect(entriesToAnnounce(INDEX, '2.0.0-beta.3', '1.9.6')).toEqual([]);
  });
});

describe('parseChangelogIndex', () => {
  it('reads a well-formed index', () => {
    const parsed = parseChangelogIndex(JSON.stringify(INDEX));
    expect(parsed?.map((e) => e.version)).toEqual(['1.9.7', '1.9.6', '1.9.5', '1.9.0']);
  });

  it('keeps the draft flag', () => {
    const parsed = parseChangelogIndex(JSON.stringify([{ ...entry('2.0.0'), draft: true }]));
    expect(parsed?.[0]?.draft).toBe(true);
  });

  it('rejects the app shell served in place of a missing file', () => {
    // A service worker or SPA fallback answering with index.html and a 200 is
    // the reason this guard exists; HTML is not a changelog.
    expect(parseChangelogIndex('<!doctype html><html></html>')).toBeNull();
  });

  it('rejects wrong shapes rather than rendering undefined', () => {
    expect(parseChangelogIndex('{}')).toBeNull();
    expect(parseChangelogIndex('[{"version":"1.0.0"}]')).toBeNull();
    expect(parseChangelogIndex('[null]')).toBeNull();
  });
});

describe('CHANGELOG.md format', () => {
  it('parses the real file', () => {
    const entries = parseChangelog(CHANGELOG);
    expect(entries.length).toBeGreaterThan(5);
    expect(entries[0]?.version).toBe('1.9.7');
    expect(entries[0]?.body).toContain('Offizieller Lösungsweg');
    expect(entries.at(-1)?.version).toBe('1.0.0');
  });

  it('has no duplicate versions and every date is ISO', () => {
    const entries = parseChangelog(CHANGELOG);
    const versions = entries.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const e of entries) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never ships an empty section', () => {
    for (const e of parseChangelog(CHANGELOG)) expect(e.body.trim()).not.toBe('');
  });
});

describe('normalizeDraft', () => {
  it('drops an H1 that is only a version echo', () => {
    expect(normalizeDraft('# QED2 1.9.7\n\nfixed: things\n', '1.9.7')).toBe('fixed: things');
  });

  it('keeps the title from the old habit, demoted', () => {
    expect(normalizeDraft('# QED2 1.9.6 - layout update!\n\nthe bar\n', '1.9.6')).toBe(
      '### layout update!\n\nthe bar',
    );
  });

  it('leaves a body with no H1 alone', () => {
    expect(normalizeDraft('### pinch to zoom\n\ntap any figure\n', '1.9.5')).toBe(
      '### pinch to zoom\n\ntap any figure',
    );
  });
});

describe('prependSection', () => {
  const base = '# Changelog\n\n## 1.0.0 — 2026-07-05\n\nfirst\n';

  it('puts the new section directly under the preamble', () => {
    const next = prependSection(base, '1.1.0', '2026-07-06', 'second')!;
    expect(parseChangelog(next).map((e) => e.version)).toEqual(['1.1.0', '1.0.0']);
    expect(next.startsWith('# Changelog')).toBe(true);
  });

  it('refuses to fold a version that already has a section', () => {
    // Idempotence is what lets the pre-commit hook run on every commit.
    expect(prependSection(base, '1.0.0', '2026-07-06', 'again')).toBeNull();
  });

  it('round-trips the body it was given', () => {
    const body = '### title\n\n- a\n- b';
    const next = prependSection(base, '1.1.0', '2026-07-06', body)!;
    expect(parseChangelog(next)[0]?.body).toBe(body);
  });
});

describe('isPrerelease', () => {
  it('treats a beta as unreleased', () => {
    expect(isPrerelease('2.0.0-beta.10')).toBe(true);
    expect(isPrerelease('2.0.0')).toBe(false);
  });
});
