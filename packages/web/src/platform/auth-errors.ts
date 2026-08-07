import { ApiError, NetworkError } from '@qed2/core-logic';

export type AuthAction = 'login' | 'invite';

/**
 * Keep server and internal exception text out of the UI. The API error body is
 * useful for diagnostics, but it is neither guaranteed to be German nor safe
 * to expose verbatim to an end user.
 */
export function authErrorMessage(error: unknown, action: AuthAction): string {
  if (error instanceof NetworkError) {
    return 'Server nicht erreichbar — bitte später versuchen.';
  }

  if (error instanceof ApiError) {
    if (action === 'login' && error.status === 401) {
      return 'Benutzername oder Passwort falsch.';
    }
    if (action === 'invite') {
      if (error.status === 409) return 'Der Benutzername ist bereits vergeben.';
      if (error.status === 429) return 'Zu viele Versuche — bitte später erneut versuchen.';
      if ([400, 401, 403, 404, 410, 422].includes(error.status)) {
        return 'Einladungscode oder Angaben sind ungültig.';
      }
    }
    return 'Die Anfrage ist fehlgeschlagen — bitte später erneut versuchen.';
  }

  return 'Die Aktion konnte nicht abgeschlossen werden — bitte erneut versuchen.';
}
