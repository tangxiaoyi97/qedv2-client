import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '@qed2/core-logic';

import { authErrorMessage } from '../src/platform/auth-errors.js';

describe('authErrorMessage', () => {
  it('maps known authentication failures to stable German messages', () => {
    expect(authErrorMessage(new ApiError(401, 'BAD_LOGIN', 'raw server text'), 'login'))
      .toBe('Benutzername oder Passwort falsch.');
    expect(authErrorMessage(new ApiError(409, 'TAKEN', 'raw server text'), 'invite'))
      .toBe('Der Benutzername ist bereits vergeben.');
    expect(authErrorMessage(new NetworkError('getaddrinfo ENOTFOUND'), 'invite'))
      .toBe('Server nicht erreichbar — bitte später versuchen.');
  });

  it('never exposes an unknown server or internal exception message', () => {
    const serverText = 'internal database shard exploded';
    const internalText = 'Guest attempts are already pending for another account.';

    expect(authErrorMessage(new ApiError(500, 'INTERNAL', serverText), 'invite'))
      .not.toContain(serverText);
    expect(authErrorMessage(new Error(internalText), 'invite')).not.toContain(internalText);
  });
});
