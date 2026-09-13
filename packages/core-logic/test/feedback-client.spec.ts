import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerClient } from '../src/api/server-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('voluntary support submission', () => {
  it('uses ordinary user authentication and projects only support fields', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'feedback-1', status: 'open', createdAt: '2026-09-13T12:00:00Z' }) });
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    const body = { category: 'bug' as const, subject: 'A support issue', message: 'A deliberate description.', clientVersion: '2.5.0', platform: 'web', archive: { secret: true }, answer: 'private', token: 'never-upload' };
    expect(await client.submitFeedback(body)).toMatchObject({ id: 'feedback-1', status: 'open' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://server.example/me/feedback');
    const init = fetcher.mock.calls[0]?.[1] as { headers: Record<string, string>; body: string; credentials: string };
    expect(init.headers.Authorization).toBe('Bearer ordinary-user-token');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body)).toEqual({ category: 'bug', subject: 'A support issue', message: 'A deliberate description.', clientVersion: '2.5.0', platform: 'web' });
  });

  it('does not silently retry when support delivery is uncertain', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network failure'));
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    await expect(client.submitFeedback({ category: 'suggestion', subject: 'A suggestion', message: 'User-written description.' })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
