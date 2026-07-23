import type { ServerInfo } from '@qed2/core-logic';

/** Compact list representation; detail views keep the complete commit. */
export function shortCommit(commit: string | null | undefined): string {
  const normalized = commit?.trim();
  return normalized ? normalized.slice(0, 7) : 'unbekannt';
}

export function databaseSchemaLabel(database: ServerInfo['database'] | undefined): string {
  return `Datenbank: Schema ${database?.schemaVersion ?? '—'}`;
}

export function databaseStatusLabel(status: NonNullable<ServerInfo['database']>['status'] | undefined): string {
  if (status === 'connected') return 'verbunden';
  if (status === 'down') return 'getrennt';
  return 'unbekannt';
}
