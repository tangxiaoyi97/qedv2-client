/**
 * Minimal JSON-over-HTTP helper shared by both service clients.
 *
 * Uses only the global `fetch` (browsers, Node >= 18, Electron, WKWebView —
 * contract §8.2). core-logic compiles without DOM or Node libs, so the few
 * platform globals used here are typed structurally instead of ambiently.
 */
import { ApiError, NetworkError, type ApiErrorBody } from './types.js';

/**
 * Structural subset of the platform AbortSignal. Real AbortSignals (DOM/Node)
 * are assignable to it; the object is forwarded to fetch untouched.
 */
interface AbortSignal {
  readonly aborted: boolean;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

/** The slice of the fetch API this module relies on. */
interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** Resolved per call so tests can stub `globalThis.fetch`. */
function getFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new NetworkError('global fetch is not available on this platform');
  }
  return f as FetchLike;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
): string {
  // Tolerate trailing/leading slashes so config values can't produce '//'.
  const base = baseUrl.replace(/\/+$/, '');
  let url = base + (path.startsWith('/') ? path : `/${path}`);
  if (query) {
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue; // absent filter, not an empty one
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    if (pairs.length > 0) url += `?${pairs.join('&')}`;
  }
  return url;
}

/** Contract §7.2 error envelope: { error: { code, message, details? } }. */
function isApiErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== 'object' || v === null) return false;
  const err = (v as { error?: unknown }).error;
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

/**
 * Perform a JSON request against `baseUrl + path`.
 *
 *  - `query` keys with undefined values are omitted (they mean "no filter").
 *  - `body` is JSON-encoded with Content-Type set; `token` becomes a Bearer
 *    Authorization header.
 *  - fetch throwing (offline, DNS, CORS, abort) → NetworkError.
 *  - non-2xx → ApiError from the contract error envelope, falling back to
 *    ApiError(status, 'HTTP_<status>', statusText) on unparsable bodies.
 *  - 204 / empty body → `undefined as T` (callers type such endpoints void).
 */
export async function requestJson<T>(
  baseUrl: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(baseUrl, path, opts.query);
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`;

  const init: FetchInit = {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal !== undefined) init.signal = opts.signal;

  let response: FetchResponse;
  let text: string;
  try {
    response = await getFetch()(url, init);
    // Body-read failures (connection reset mid-stream) are network-level too.
    text = await response.text();
  } catch (err) {
    if (err instanceof NetworkError) throw err;
    throw new NetworkError(`request failed: ${init.method} ${url}`, err);
  }

  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isApiErrorBody(parsed)) {
      const { code, message, details } = parsed.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(
      response.status,
      `HTTP_${response.status}`,
      response.statusText || `HTTP ${response.status}`,
    );
  }

  if (response.status === 204 || text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, 'INVALID_JSON', 'response body is not valid JSON');
  }
}
