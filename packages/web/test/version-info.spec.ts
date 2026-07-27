import { describe, expect, it } from 'vitest';
import { databaseSchemaLabel, databaseStatusLabel, shortCommit } from '../src/version-info.js';
import rootPkg from '../../../package.json';
import webPkg from '../../web/package.json';
import uiPkg from '../../ui/package.json';
import corePkg from '../../core-logic/package.json';

describe('release version', () => {
  it('is the same number in the root and in every workspace package', () => {
    // The settings page shows __APP_VERSION__, which vite.config reads from
    // packages/web/package.json (scripts/commit.mjs) — NOT from the root. A
    // release that bumps only the root therefore ships the previous version
    // number next to a correct commit hash, which is exactly what 1.9.5 did.
    expect({ web: webPkg.version, ui: uiPkg.version, core: corePkg.version }).toEqual({
      web: rootPkg.version,
      ui: rootPkg.version,
      core: rootPkg.version,
    });
  });
});

describe('version info formatting', () => {
  it('uses short commits in lists without inventing a value', () => {
    expect(shortCommit('5feb967f5f082cf121772f67f0be5f204cb53115')).toBe('5feb967');
    expect(shortCommit(null)).toBe('unbekannt');
    expect(shortCommit('   ')).toBe('unbekannt');
  });

  it('reports the applied database schema version', () => {
    expect(
      databaseSchemaLabel({
        status: 'connected',
        provider: 'postgresql',
        schemaVersion: 3,
        latestMigration: '20260723235500_add_leaderboard',
      }),
    ).toBe('Datenbank: Schema 3');
    expect(
      databaseSchemaLabel({
        status: 'down',
        provider: 'postgresql',
        schemaVersion: null,
        latestMigration: null,
      }),
    ).toBe('Datenbank: Schema —');
    expect(databaseStatusLabel('connected')).toBe('verbunden');
    expect(databaseStatusLabel('down')).toBe('getrennt');
    expect(databaseStatusLabel(undefined)).toBe('unbekannt');
    expect(databaseSchemaLabel(undefined)).toBe('Datenbank: Schema —');
  });
});
