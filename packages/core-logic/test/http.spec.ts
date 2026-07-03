import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from '../src/api/http.js';
import { ApiError, NetworkError } from '../src/api/types.js';

/** What our stub records about each fetch invocation. */
interface RecordedCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: unknown;
  };
}

interface StubReply {
  status?: number;
  statusText?: string;
  body?: string;
}

function stubFetch(reply: StubReply = {}): RecordedCall[] {
  const { status = 200, statusText = '', body = '' } = reply;
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', (url: string, init: RecordedCall['init']) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: () => Promise.resolve(body),
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestJson URL building', () => {
  it('joins base and path without double slashes', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test///', '/health');
    expect(calls[0]?.url).toBe('http://x.test/health');
  });

  it('prefixes a missing leading slash on the path', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', 'health');
    expect(calls[0]?.url).toBe('http://x.test/health');
  });

  it('serializes query params, encodes values, skips undefined', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', '/content/questions', {
      query: { kind: 'interval', gk: 'AN 4.3', page: 2, pageSize: undefined },
    });
    expect(calls[0]?.url).toBe('http://x.test/content/questions?kind=interval&gk=AN%204.3&page=2');
  });

  it('appends no "?" when every query value is undefined', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', '/p', { query: { a: undefined } });
    expect(calls[0]?.url).toBe('http://x.test/p');
  });
});

describe('requestJson headers and body', () => {
  it('sets Content-Type and JSON body for POST with body', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', '/p', { method: 'POST', body: { a: 1 } });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe('{"a":1}');
  });

  it('omits Content-Type and body when no body given', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', '/p');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers).not.toHaveProperty('Content-Type');
    expect(calls[0]?.init).not.toHaveProperty('body');
  });

  it('sets Authorization: Bearer when a token is given', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', '/p', { token: 'tok-123' });
    expect(calls[0]?.init.headers['Authorization']).toBe('Bearer tok-123');
  });

  it('omits Authorization when no token is given', async () => {
    const calls = stubFetch({ body: '{}' });
    await requestJson('http://x.test', '/p');
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
  });

  it('forwards the abort signal to fetch', async () => {
    const calls = stubFetch({ body: '{}' });
    const signal = { aborted: false };
    await requestJson('http://x.test', '/p', { signal });
    expect(calls[0]?.init.signal).toBe(signal);
  });
});

describe('requestJson error handling', () => {
  it('parses the contract error envelope into ApiError fields', async () => {
    stubFetch({
      status: 401,
      body: '{"error":{"code":"UNAUTHENTICATED","message":"missing bearer token","details":{"hint":"login"}}}',
    });
    const err = await requestJson('http://x.test', '/me/state').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.status).toBe(401);
    expect(api.code).toBe('UNAUTHENTICATED');
    expect(api.message).toBe('missing bearer token');
    expect(api.details).toEqual({ hint: 'login' });
  });

  it('envelope without details leaves ApiError.details undefined', async () => {
    stubFetch({ status: 404, body: '{"error":{"code":"QUESTION_NOT_FOUND","message":"nope"}}' });
    const err = (await requestJson('http://x.test', '/q').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('QUESTION_NOT_FOUND');
    expect(err.details).toBeUndefined();
  });

  it('falls back to HTTP_<status> + statusText on unparsable bodies', async () => {
    stubFetch({ status: 502, statusText: 'Bad Gateway', body: '<html>boom</html>' });
    const err = (await requestJson('http://x.test', '/p').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('HTTP_502');
    expect(err.message).toBe('Bad Gateway');
  });

  it('falls back for JSON bodies that are not the envelope shape', async () => {
    stubFetch({ status: 500, statusText: 'Internal Server Error', body: '{"oops":true}' });
    const err = (await requestJson('http://x.test', '/p').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('HTTP_500');
  });

  it('wraps a throwing fetch into NetworkError with cause', async () => {
    const boom = new Error('ECONNREFUSED');
    vi.stubGlobal('fetch', () => Promise.reject(boom));
    const err = await requestJson('http://x.test', '/p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).cause).toBe(boom);
  });

  it('wraps a body-read failure into NetworkError', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        text: () => Promise.reject(new Error('stream reset')),
      }),
    );
    const err = await requestJson('http://x.test', '/p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
  });
});

describe('requestJson response bodies', () => {
  it('parses a 2xx JSON body', async () => {
    stubFetch({ body: '{"status":"ok","uptime":12}' });
    await expect(requestJson('http://x.test', '/health')).resolves.toEqual({
      status: 'ok',
      uptime: 12,
    });
  });

  it('returns undefined for 204', async () => {
    stubFetch({ status: 204, body: '' });
    await expect(requestJson('http://x.test', '/p')).resolves.toBeUndefined();
  });

  it('returns undefined for a 200 with an empty body', async () => {
    stubFetch({ status: 200, body: '' });
    await expect(requestJson('http://x.test', '/p')).resolves.toBeUndefined();
  });

  it('throws ApiError(INVALID_JSON) for a malformed 2xx body', async () => {
    stubFetch({ status: 200, body: 'not-json' });
    const err = (await requestJson('http://x.test', '/p').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INVALID_JSON');
  });
});
