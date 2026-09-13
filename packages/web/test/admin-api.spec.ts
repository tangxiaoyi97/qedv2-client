import { describe, expect, it, vi } from 'vitest';
import { ManagementClient, normalizeNodeAddress, validateManagementPassword } from '../src/admin/api.js';

const grant = (token = 'server-session-token-1234567890', setup = false) => ({ token, requiresPasswordSetup: setup, expiresAt: new Date(Date.now() + 600_000).toISOString() });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('independent management transport', () => {
  it('accepts secure origins and loopback development while rejecting embedded secrets', () => {
    expect(normalizeNodeAddress('https://qedsync.example/management/')).toBe('https://qedsync.example');
    expect(normalizeNodeAddress('http://127.0.0.1:18081')).toBe('http://127.0.0.1:18081');
    expect(normalizeNodeAddress('http://[::1]:8081/')).toBe('http://[::1]:8081');
    for (const address of ['http://remote.example', 'https://admin:secret@example.org', 'https://example.org?token=secret', 'https://example.org/#secret', 'https://example.org/private', 'javascript:alert(1)', '//example.org']) {
      expect(() => normalizeNodeAddress(address)).toThrow();
    }
  });

  it('never sends cookies, allows redirects, caches responses, or mixes credentials between nodes', async () => {
    const serverFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json(grant())).mockResolvedValueOnce(json({ users: [] }));
    const coreFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ service: 'qed2-core', initialized: false }));
    const server = new ManagementClient('https://server.example', serverFetch);
    const core = new ManagementClient('https://core.example', coreFetch);
    await server.login('local-test-secret');
    await server.request('/users?page=1');
    await core.status();
    expect(serverFetch.mock.calls[0]?.[0]).toBe('https://server.example/management/auth/login');
    expect(serverFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    expect(serverFetch.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: `Bearer ${grant().token}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(coreFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    await expect(core.request('/info')).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    expect(server.session?.requiresPasswordSetup).toBe(false);
  });

  it('uses setup grants only until password commit returns the replacement token', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(grant('setup-only-token-1234567890', true)))
      .mockResolvedValueOnce(json(grant('replacement-admin-token-1234567890')))
      .mockResolvedValueOnce(json({ version: '1.14.0' }));
    const client = new ManagementClient('https://core.example', fetcher);
    await client.login('test-bootstrap');
    expect(client.session?.requiresPasswordSetup).toBe(true);
    await client.setup('a test password of sufficient length');
    await client.request('/info');
    expect(fetcher.mock.calls[1]?.[1]?.headers).toHaveProperty('Authorization', 'Bearer setup-only-token-1234567890');
    expect(fetcher.mock.calls[2]?.[1]?.headers).toHaveProperty('Authorization', 'Bearer replacement-admin-token-1234567890');
  });

  it('does not retry ambiguous mutations and clears local credentials even when logout fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(grant())).mockRejectedValue(new TypeError('network lost with secret details'));
    const client = new ManagementClient('https://server.example', fetcher);
    await client.login('test-secret');
    await expect(client.request('/users', { username: 'newuser' })).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('操作结果尚未确认') });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(client.session).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('forgets revoked sessions and does not display arbitrary server errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(grant())).mockResolvedValueOnce(json({ error: { code: 'INVALID_SESSION', message: 'secret from backend' } }, 401));
    const client = new ManagementClient('https://server.example', fetcher);
    await client.login('test-secret');
    await expect(client.request('/info')).rejects.toMatchObject({ code: 'INVALID_SESSION', message: '会话已过期，请重新登录。' });
    expect(client.session).toBeNull();
  });

  it('bounds Unicode passwords by UTF-8 bytes and never truncates', () => {
    expect(() => validateManagementPassword('短密码')).toThrow();
    expect(() => validateManagementPassword('密'.repeat(85))).not.toThrow();
    expect(() => validateManagementPassword('密'.repeat(86))).toThrow();
    expect(() => validateManagementPassword('x'.repeat(257))).toThrow();
  });

  it('does not allow a request path to redirect bearer credentials to another origin', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new ManagementClient('https://server.example', fetcher);
    for (const path of ['//evil.example/steal', '/../../steal', 'https://evil.example', '/info#token']) {
      await expect(client.request(path)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
