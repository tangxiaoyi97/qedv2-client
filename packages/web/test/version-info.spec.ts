import { describe, expect, it } from 'vitest';
import { databaseSchemaLabel, databaseStatusLabel, shortCommit } from '../src/version-info.js';

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
