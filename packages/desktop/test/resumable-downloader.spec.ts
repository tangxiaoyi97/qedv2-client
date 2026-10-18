import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdtemp, readFile, readdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResumableArtifactDownloader,
  type ArtifactDescriptor,
  type ResumableDownloadLogger,
} from '../src/main/resumable-downloader.js';
import {
  buildReleaseAssetUrl,
  fetchApprovedReleaseUrl,
} from '../src/main/release-feed.js';

const roots: string[] = [];
const payload = Buffer.from('qed2-update');

function digest(algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return createHash(algorithm).update(payload).digest(encoding);
}

const descriptor: ArtifactDescriptor = {
  fromVersion: '2.0.0',
  targetVersion: '2.1.0',
  releaseTag: 'v2.1.0',
  assetName: 'QED2-2.1.0-mac-arm64.dmg',
  size: payload.length,
  sha256: digest('sha256', 'hex'),
  sha512: digest('sha512', 'base64'),
  installMode: 'manual-package',
};

function logger(): ResumableDownloadLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qed2-resumable-'));
  roots.push(directory);
  return directory;
}

function response(
  bytes: Uint8Array,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(bytes, { status, headers });
}

function downloader(
  directory: string,
  fetchImpl: typeof fetch,
  availableBytes: () => Promise<number> = async () => 1024 * 1024 * 1024,
): ResumableArtifactDownloader {
  return new ResumableArtifactDownloader(directory, logger(), {
    fetch: fetchImpl,
    reserveBytes: 0,
    checkpointBytes: 1,
    checkpointMs: 0,
    idleTimeoutMs: 1_000,
    availableBytes,
    now: () => Date.parse('2026-08-08T00:00:00.000Z'),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('ResumableArtifactDownloader', () => {
  it.each(['discard', 'inspect', 'resetAutomaticRecovery', 'pauseRecovery', 'cleanupExpiredDownloads'] as const)(
    '%s locks the cache before its first asynchronous filesystem operation', async (operation) => {
      const directory = await root();
      const fetchMock = vi.fn(async () => response(payload, 200, { etag: '"release"' })) as unknown as typeof fetch;
      const instance = downloader(directory, fetchMock);
      const maintaining = instance[operation]();
      await expect(instance.stage(descriptor)).rejects.toMatchObject({ code: 'ERR_DOWNLOAD_BUSY' });
      expect(fetchMock).not.toHaveBeenCalled();
      await maintaining;
      const verified = await instance.stage(descriptor);
      expect(await readFile(verified.path)).toEqual(payload);
    },
  );

  it('does not start an already aborted download', async () => {
    const directory = await root();
    const fetchMock = vi.fn();
    const reason = Object.assign(new Error('paused'), { code: 'ERR_CANCELLED' });
    await expect(downloader(directory, fetchMock).stage(descriptor, {
      signal: AbortSignal.abort(reason),
    })).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('aborts an idle reader promptly, checkpoints its bytes, and does not await a stuck cancellation', async () => {
    const directory = await root();
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) { streamController.enqueue(payload.subarray(0, 5)); },
      cancel,
    });
    const first = downloader(directory, vi.fn(async () => new Response(stream, {
      headers: { etag: '"qed2-v2.1.0"' },
    })) as unknown as typeof fetch);
    let checkpointed!: () => void;
    const hasCheckpoint = new Promise<void>((resolve) => { checkpointed = resolve; });
    const download = first.stage(descriptor, {
      signal: controller.signal,
      onProgress: ({ persistedBytes }) => { if (persistedBytes === 5) checkpointed(); },
    });
    const rejection = expect(download).rejects.toMatchObject({ code: 'ERR_CANCELLED' });
    await hasCheckpoint;
    controller.abort(Object.assign(new Error('paused'), { code: 'ERR_CANCELLED' }));
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    await expect(first.inspect()).resolves.toMatchObject({ downloadedBytes: 5, state: 'partial' });
    await first.pauseRecovery();
    await expect(first.inspect()).resolves.toMatchObject({ paused: true });
    await first.resetAutomaticRecovery();
    expect((await first.inspect())?.paused).toBeUndefined();
  });

  it('stops before verification promotion and reuses the fully persisted partial on retry', async () => {
    const directory = await root();
    const fetchMock = vi.fn(async () => response(payload, 200, { etag: '"release"' })) as unknown as typeof fetch;
    const instance = downloader(directory, fetchMock);
    const controller = new AbortController();
    await expect(instance.stage(descriptor, {
      signal: controller.signal,
      onVerifying: () => controller.abort(Object.assign(new Error('paused'), { code: 'ERR_CANCELLED' })),
    })).rejects.toMatchObject({ code: 'ERR_CANCELLED' });
    expect(await readdir(directory)).not.toContain(descriptor.assetName);
    await expect(instance.inspect()).resolves.toMatchObject({ downloadedBytes: payload.length, state: 'partial' });
    const verified = await instance.stage(descriptor);
    expect(await readFile(verified.path)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels the network body when the journal becomes unwritable after response headers', async () => {
    if (process.platform === 'win32') return; // Windows ACL behavior is not represented by POSIX chmod.
    const directory = await root();
    const cancel = vi.fn();
    const instance = downloader(directory, vi.fn(async () => {
      await chmod(directory, 0o500);
      return new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { etag: '"release"' } });
    }) as unknown as typeof fetch);
    try {
      await expect(instance.stage(descriptor)).rejects.toMatchObject({ code: 'EACCES' });
      expect(cancel).toHaveBeenCalledOnce();
    } finally { await chmod(directory, 0o700); }
  });

  it('recognizes GitHub secondary rate limits on HTTP 403 and closes their body', async () => {
    const directory = await root();
    const cancel = vi.fn();
    const instance = downloader(directory, vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { status: 403, headers: { 'retry-after': '120' } },
    )) as unknown as typeof fetch);
    await expect(instance.stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_UPDATER_RATE_LIMITED', retryAfter: '120', statusCode: 403,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('persists byte progress and verifies size plus both hashes', async () => {
    const directory = await root();
    const fetchMock = vi.fn(async () => response(payload, 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    const progress: number[] = [];

    const verified = await downloader(directory, fetchMock).stage(descriptor, {
      onProgress: ({ persistedBytes }) => progress.push(persistedBytes),
    });

    expect(await readFile(verified.path)).toEqual(payload);
    expect(verified).toMatchObject({
      size: payload.length,
      sha256: descriptor.sha256,
      sha512: descriptor.sha512,
      reused: false,
    });
    expect(progress.at(-1)).toBe(payload.length);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the manifest size as authority when Content-Length is omitted', async () => {
    const directory = await root();
    const fetchMock = vi.fn(async () => response(payload, 200, {
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;

    const verified = await downloader(directory, fetchMock).stage(descriptor);

    expect(await readFile(verified.path)).toEqual(payload);
    expect(verified.size).toBe(payload.length);
  });

  it('resumes across downloader instances with Range and If-Range', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 5), 200, {
      // The declared release size remains authoritative when the socket body
      // ends early.
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    const first = downloader(directory, firstFetch);
    await expect(first.stage(descriptor)).rejects.toMatchObject({ code: 'ERR_DOWNLOAD_TRUNCATED' });
    await expect(first.inspect()).resolves.toMatchObject({ downloadedBytes: 5, state: 'partial' });

    const secondFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('range')).toBe('bytes=5-');
      expect(headers.get('if-range')).toBe('"qed2-v2.1.0"');
      return response(payload.subarray(5), 206, {
        'content-length': String(payload.length - 5),
        'content-range': `bytes 5-${payload.length - 1}/${payload.length}`,
        etag: '"qed2-v2.1.0"',
      });
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const verified = await downloader(directory, secondFetch).stage(descriptor, {
      onProgress: ({ persistedBytes }) => progress.push(persistedBytes),
    });

    expect(await readFile(verified.path)).toEqual(payload);
    expect(progress[0]).toBe(5);
    expect(progress.at(-1)).toBe(payload.length);
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });

  it('restarts once from zero when a server ignores Range instead of appending', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 4), 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    await expect(downloader(directory, firstFetch).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_TRUNCATED',
    });

    const headersSeen: Array<{ range: string | null; ifRange: string | null }> = [];
    const resumedFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headersSeen.push({ range: headers.get('range'), ifRange: headers.get('if-range') });
      return response(payload, 200, {
        'content-length': String(payload.length),
        etag: '"qed2-v2.1.0"',
      });
    }) as unknown as typeof fetch;

    const verified = await downloader(directory, resumedFetch).stage(descriptor);
    expect(await readFile(verified.path)).toEqual(payload);
    expect(headersSeen).toEqual([
      { range: 'bytes=4-', ifRange: '"qed2-v2.1.0"' },
      { range: null, ifRange: null },
    ]);
    expect(await readdir(directory)).toContainEqual(
      expect.stringMatching(/^QED2-2\.1\.0-mac-arm64\.dmg\.part\.range-ignored-/),
    );
  });

  it('rechecks full-file capacity before restarting a download whose Range was ignored', async () => {
    const directory = await root();
    await expect(downloader(directory, vi.fn(async () => response(payload.subarray(0, 4), 200, {
      etag: '"release"',
    })) as unknown as typeof fetch).stage(descriptor)).rejects.toMatchObject({ code: 'ERR_DOWNLOAD_TRUNCATED' });
    const fetchMock = vi.fn(async () => response(payload, 200, { etag: '"release"' })) as unknown as typeof fetch;
    const instance = downloader(directory, fetchMock, async () => payload.length - 4);
    await expect(instance.stage(descriptor)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(instance.inspect()).resolves.toMatchObject({ downloadedBytes: 0, state: 'partial' });
  });

  it('drops a partial file and restarts when the strong ETag changes', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 4), 200, {
      'content-length': String(payload.length),
      etag: '"old"',
    })) as unknown as typeof fetch;
    await expect(downloader(directory, firstFetch).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_TRUNCATED',
    });

    let call = 0;
    const resumedFetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? response(payload.subarray(4), 206, {
            'content-length': String(payload.length - 4),
            'content-range': `bytes 4-${payload.length - 1}/${payload.length}`,
            etag: '"new"',
          })
        : response(payload, 200, {
            'content-length': String(payload.length),
            etag: '"new"',
          });
    }) as unknown as typeof fetch;

    const verified = await downloader(directory, resumedFetch).stage(descriptor);
    expect(await readFile(verified.path)).toEqual(payload);
    expect(resumedFetch).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toContainEqual(
      expect.stringMatching(/^QED2-2\.1\.0-mac-arm64\.dmg\.part\.validator-changed-/),
    );
  });

  it('truncates an uncheckpointed crash tail and resumes from the durable journal byte', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 4), 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    await expect(downloader(directory, firstFetch).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_TRUNCATED',
    });
    await appendFile(join(directory, `${descriptor.assetName}.part`), Buffer.from('tamper'));

    const headersSeen: Array<{ range: string | null; ifRange: string | null }> = [];
    const resumedFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headersSeen.push({ range: headers.get('range'), ifRange: headers.get('if-range') });
      return response(payload.subarray(4), 206, {
        'content-length': String(payload.length - 4),
        'content-range': `bytes 4-${payload.length - 1}/${payload.length}`,
        etag: '"qed2-v2.1.0"',
      });
    }) as unknown as typeof fetch;

    await expect(downloader(directory, resumedFetch).stage(descriptor)).resolves.toMatchObject({
      size: payload.length,
    });
    expect(headersSeen).toEqual([{
      range: 'bytes=4-',
      ifRange: '"qed2-v2.1.0"',
    }]);
    expect(await readFile(join(directory, descriptor.assetName))).toEqual(payload);
    expect(await readdir(directory)).not.toContainEqual(
      expect.stringMatching(/\.state-mismatch-/),
    );
  });

  it('isolates a partial truncated below its durable journal and restarts from zero', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 6), 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    await expect(downloader(directory, firstFetch).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_TRUNCATED',
    });
    await truncate(join(directory, `${descriptor.assetName}.part`), 3);

    const headersSeen: Array<{ range: string | null; ifRange: string | null }> = [];
    const freshFetch = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headersSeen.push({ range: headers.get('range'), ifRange: headers.get('if-range') });
      return response(payload, 200, {
        'content-length': String(payload.length),
        etag: '"qed2-v2.1.0"',
      });
    }) as unknown as typeof fetch;

    await expect(downloader(directory, freshFetch).stage(descriptor)).resolves.toMatchObject({
      size: payload.length,
    });
    expect(headersSeen).toEqual([{ range: null, ifRange: null }]);
    expect(await readdir(directory)).toContainEqual(
      expect.stringMatching(/^QED2-2\.1\.0-mac-arm64\.dmg\.part\.state-mismatch-/),
    );
  });

  it('rejects a resumed response whose Content-Range does not exactly cover the approved remainder', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 4), 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    await expect(downloader(directory, firstFetch).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_TRUNCATED',
    });

    const invalidRange = vi.fn(async () => response(payload.subarray(4), 206, {
      'content-length': String(payload.length - 4),
      'content-range': `bytes 3-${payload.length - 1}/${payload.length}`,
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;

    await expect(downloader(directory, invalidRange).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_PROTOCOL',
    });
    expect(downloader(directory, invalidRange).hasRecoverySync()).toBe(false);
  });

  it('never exposes or reuses an asset with a wrong checksum', async () => {
    const directory = await root();
    const corrupt = Buffer.from('qed2-updatf');
    const fetchMock = vi.fn(async () => response(corrupt, 200, {
      'content-length': String(corrupt.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;

    await expect(downloader(directory, fetchMock).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_INTEGRITY',
    });
    expect(downloader(directory, fetchMock).hasRecoverySync()).toBe(false);
  });

  it('rejects an asset when SHA-256 matches but SHA-512 does not', async () => {
    const directory = await root();
    const fetchMock = vi.fn(async () => response(payload, 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;

    await expect(downloader(directory, fetchMock).stage({
      ...descriptor,
      sha512: Buffer.alloc(64, 0x5a).toString('base64'),
    })).rejects.toMatchObject({ code: 'ERR_DOWNLOAD_INTEGRITY' });
    expect(downloader(directory, fetchMock).hasRecoverySync()).toBe(false);
  });

  it('rejects redirects outside the exact GitHub release CDN boundary', async () => {
    const directory = await root();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/qed2.dmg' },
    })) as unknown as typeof fetch;

    await expect(downloader(directory, fetchMock).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_UPDATER_REDIRECT_REJECTED',
    });
  });

  it('follows a bounded redirect only onto the approved GitHub release CDN', async () => {
    const directory = await root();
    const cdnUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/qed2?sig=opaque';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdnUrl } }))
      .mockResolvedValueOnce(response(payload, 200, {
        'content-length': String(payload.length),
        etag: '"qed2-v2.1.0"',
      }));

    await expect(downloader(directory, fetchMock as unknown as typeof fetch).stage(descriptor)).resolves.toMatchObject({
      size: payload.length,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(cdnUrl);
  });

  it('strips credentials, cookies, tokens, methods, and bodies before every release request', async () => {
    const cdnUrl = 'https://objects.githubusercontent.com/github-production-release-asset/qed2?sig=opaque';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: cdnUrl } }))
      .mockResolvedValueOnce(response(payload, 200));

    await fetchApprovedReleaseUrl(
      new URL(buildReleaseAssetUrl(descriptor.releaseTag, descriptor.assetName)),
      {
        method: 'POST',
        body: 'must-not-leave-the-process',
        credentials: 'include',
        headers: {
          Accept: 'application/octet-stream',
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          'X-GitHub-Token': 'secret',
          Range: 'bytes=4-',
          'If-Range': '"qed2-v2.1.0"',
        },
      },
      fetchMock as unknown as typeof fetch,
    );

    for (const call of fetchMock.mock.calls) {
      const request = call[1] as RequestInit;
      const headers = new Headers(request.headers);
      expect(request).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      expect(request.body).toBeUndefined();
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('x-github-token')).toBeNull();
      expect(headers.get('range')).toBe('bytes=4-');
      expect(headers.get('if-range')).toBe('"qed2-v2.1.0"');
    }
  });

  it('aborts an asset request that never produces response headers', async () => {
    const fetchMock = vi.fn((_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('expected a bounded request signal'));
        const rejectAborted = () => reject(signal.reason);
        if (signal.aborted) rejectAborted();
        else signal.addEventListener('abort', rejectAborted, { once: true });
      })) as unknown as typeof fetch;

    await expect(fetchApprovedReleaseUrl(
      new URL(buildReleaseAssetUrl(descriptor.releaseTag, descriptor.assetName)),
      { headers: { Accept: 'application/octet-stream' } },
      fetchMock,
      10,
    )).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing partial download when storage is temporarily full', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 6), 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    await expect(downloader(directory, firstFetch).stage(descriptor)).rejects.toMatchObject({
      code: 'ERR_DOWNLOAD_TRUNCATED',
    });

    const noNetwork = vi.fn(async () => {
      throw new Error('network must not run before the disk preflight');
    }) as unknown as typeof fetch;
    const fullDisk = downloader(directory, noNetwork, async () => 0);
    await expect(fullDisk.stage(descriptor)).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fullDisk.inspect()).resolves.toMatchObject({ downloadedBytes: 6, state: 'partial' });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('persists storage pressure as a manual-only recovery gate without consuming attempts', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload.subarray(0, 6), 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    const instance = downloader(directory, firstFetch);
    await expect(instance.stage(descriptor)).rejects.toMatchObject({ code: 'ERR_DOWNLOAD_TRUNCATED' });

    await instance.recordAutomaticFailure('APP_UPDATE_STORAGE_UNAVAILABLE', undefined, 4);
    await expect(instance.inspect()).resolves.toMatchObject({
      automaticAttempts: 0,
      manualRetryRequired: true,
      lastErrorCode: 'APP_UPDATE_STORAGE_UNAVAILABLE',
    });

    await instance.resetAutomaticRecovery();
    const reset = await instance.inspect();
    expect(reset).toMatchObject({ automaticAttempts: 0 });
    expect(reset?.manualRetryRequired).toBeUndefined();
    expect(reset?.lastErrorCode).toBeUndefined();
  });

  it('revalidates a verified artifact after restart without network traffic', async () => {
    const directory = await root();
    const firstFetch = vi.fn(async () => response(payload, 200, {
      'content-length': String(payload.length),
      etag: '"qed2-v2.1.0"',
    })) as unknown as typeof fetch;
    await downloader(directory, firstFetch).stage(descriptor);

    const noNetwork = vi.fn(async () => {
      throw new Error('verified cache must not be downloaded again');
    }) as unknown as typeof fetch;
    const verified = await downloader(directory, noNetwork).stage(descriptor);
    expect(verified.reused).toBe(true);
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
