const UPDATE_REPOSITORY_OWNER = 'tangxiaoyi97';
const UPDATE_REPOSITORY_NAME = 'qedv2-client';
const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
const MAX_RELEASE_API_BYTES = 512 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_ASSETS = 128;
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_RELEASE_HEADER_TIMEOUT_MS = 30_000;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RELEASE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MANUAL_PACKAGE_NAME_PATTERN = /\.(?:dmg|exe|AppImage|deb|rpm)$/;
const APPROVED_REDIRECT_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const APPROVED_RELEASE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'if-range',
  'range',
  'user-agent',
]);

export interface ApprovedReleaseTarget {
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64';
  installMode: 'manual-package';
}

export interface ApprovedReleaseAsset {
  name: string;
  size: number;
  sha256: string;
  sha512: string;
  downloadUrl: string;
  target?: ApprovedReleaseTarget;
}

export interface ApprovedDesktopRelease {
  tag: string;
  version: string;
  clientCommit: string;
  coreCommit: string;
  bankCommit: string;
  assets: Readonly<Record<string, ApprovedReleaseAsset>>;
  updateMetadata: Readonly<Record<'latest.yml' | 'latest-mac.yml' | 'latest-linux.yml', readonly string[]>>;
}

interface GitHubReleaseAsset {
  name: string;
  size: number;
  browserDownloadUrl: string;
}

export function expectedManualReleaseTargets(version: string): ReadonlyMap<string, ApprovedReleaseTarget> {
  if (!STABLE_VERSION_PATTERN.test(version)) return new Map<string, ApprovedReleaseTarget>();
  return new Map<string, ApprovedReleaseTarget>([
    [`QED2-${version}-mac-arm64.dmg`, { platform: 'darwin', arch: 'arm64', installMode: 'manual-package' }],
    [`QED2-${version}-mac-x64.dmg`, { platform: 'darwin', arch: 'x64', installMode: 'manual-package' }],
    [`QED2-${version}-win-x64.exe`, { platform: 'win32', arch: 'x64', installMode: 'manual-package' }],
    [`QED2-${version}-linux-x64.AppImage`, { platform: 'linux', arch: 'x64', installMode: 'manual-package' }],
    [`QED2-${version}-linux-x64.deb`, { platform: 'linux', arch: 'x64', installMode: 'manual-package' }],
    [`QED2-${version}-linux-x64.rpm`, { platform: 'linux', arch: 'x64', installMode: 'manual-package' }],
  ]);
}

export function isCanonicalSha512(value: unknown): value is string {
  if (typeof value !== 'string' || !SHA512_BASE64_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === value;
}

function exactReleaseTarget(value: unknown, expected: ApprovedReleaseTarget): value is ApprovedReleaseTarget {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ['platform', 'arch', 'installMode']) &&
    value.platform === expected.platform &&
    value.arch === expected.arch &&
    value.installMode === 'manual-package'
  );
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function codedReleaseError(message: string, code: string, statusCode?: number): Error {
  return Object.assign(new Error(message), {
    code,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function isRateLimitedResponse(response: Response): boolean {
  return response.status === 429 || (
    response.status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.has('retry-after')
    )
  );
}

function isTransportFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate = error;
  for (let depth = 0; depth < 4 && typeof candidate === 'object' && candidate !== null; depth += 1) {
    if (seen.has(candidate)) break;
    seen.add(candidate);
    const current = candidate as { code?: unknown; name?: unknown; cause?: unknown };
    if (
      current.name === 'AbortError' ||
      current.name === 'TimeoutError' ||
      (typeof current.code === 'string' && /^(?:EAI_AGAIN|ECONN|EHOST|ENET|ENOTFOUND|ETIMEDOUT|ERR_NETWORK|UND_ERR_)/.test(current.code.toUpperCase()))
    ) return true;
    candidate = current.cause;
  }
  return false;
}

async function readBoundedJson(response: Response, maximumBytes: number, label: string): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw codedReleaseError(`${label} exceeds the size limit`, 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  if (!response.body) {
    throw codedReleaseError(`${label} has no body`, 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw codedReleaseError(`${label} exceeds the size limit`, 'ERR_UPDATER_INVALID_RELEASE_FEED');
      }
      chunks.push(value);
    }
    const source = new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length));
    return JSON.parse(source) as unknown;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'ERR_UPDATER_INVALID_RELEASE_FEED') throw error;
    if (isTransportFailure(error)) throw error;
    throw codedReleaseError(`${label} is malformed`, 'ERR_UPDATER_INVALID_RELEASE_FEED');
  } finally {
    reader.releaseLock();
  }
}

export function buildReleaseAssetUrl(tag: string, assetName: string): string {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw codedReleaseError('Desktop release tag is invalid', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  if (!RELEASE_ASSET_NAME_PATTERN.test(assetName)) {
    throw codedReleaseError('Desktop release asset name is invalid', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  return `https://github.com/${UPDATE_REPOSITORY_OWNER}/${UPDATE_REPOSITORY_NAME}/releases/download/${tag}/${assetName}`;
}

export function isApprovedReleaseAssetUrl(url: URL, tag: string, assetName: string): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.port === '' &&
    url.pathname === new URL(buildReleaseAssetUrl(tag, assetName)).pathname &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}

function approvedRedirectUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    APPROVED_REDIRECT_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    url.href.length <= 8_192
  );
}

function approvedReleaseRequest(init: RequestInit): RequestInit {
  const headers = new Headers();
  for (const [name, value] of new Headers(init.headers)) {
    if (APPROVED_RELEASE_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return {
    headers,
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    ...(init.signal ? { signal: init.signal } : {}),
  };
}

/** Fetches a fixed GitHub release URL without allowing an arbitrary redirect target. */
export async function fetchApprovedReleaseUrl(
  initialUrl: URL,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  headerTimeoutMs = DEFAULT_RELEASE_HEADER_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isFinite(headerTimeoutMs) || headerTimeoutMs <= 0 || headerTimeoutMs > 120_000) {
    throw new TypeError('Release response-header timeout is invalid');
  }
  let url = initialUrl;
  const approved = approvedReleaseRequest(init);
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(Object.assign(new Error('Desktop release response headers timed out'), {
      name: 'TimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    }));
  }, headerTimeoutMs);
  timer.unref();
  const signal = approved.signal
    ? AbortSignal.any([approved.signal, deadline.signal])
    : deadline.signal;
  const request: RequestInit = { ...approved, signal };
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetchImpl(url, request);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects === MAX_REDIRECTS) {
        response.body?.cancel().catch(() => undefined);
        throw codedReleaseError('Desktop release download redirected too many times', 'ERR_UPDATER_REDIRECT_REJECTED');
      }
      const location = response.headers.get('location');
      response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw codedReleaseError('Desktop release redirect has no location', 'ERR_UPDATER_REDIRECT_REJECTED');
      }
      let redirected: URL;
      try {
        redirected = new URL(location, url);
      } catch {
        throw codedReleaseError('Desktop release redirect is malformed', 'ERR_UPDATER_REDIRECT_REJECTED');
      }
      if (!approvedRedirectUrl(redirected)) {
        throw codedReleaseError('Desktop release redirect escaped the approved GitHub CDN', 'ERR_UPDATER_REDIRECT_REJECTED');
      }
      url = redirected;
    }
    throw codedReleaseError('Desktop release redirect failed', 'ERR_UPDATER_REDIRECT_REJECTED');
  } finally {
    clearTimeout(timer);
  }
}

function parseApprovedReleaseManifest(
  value: unknown,
  expectedTag: string,
  githubAssets: ReadonlyMap<string, GitHubReleaseAsset>,
): ApprovedDesktopRelease {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ['formatVersion', 'tag', 'version', 'sources', 'updateMetadata', 'assets']) ||
    value.formatVersion !== 2 ||
    value.tag !== expectedTag ||
    typeof value.version !== 'string' ||
    !STABLE_VERSION_PATTERN.test(value.version) ||
    value.tag !== `v${value.version}` ||
    !isRecord(value.sources) ||
    !hasExactOwnKeys(value.sources, ['client', 'core', 'bank']) ||
    !GIT_COMMIT_PATTERN.test(String(value.sources.client)) ||
    !GIT_COMMIT_PATTERN.test(String(value.sources.core)) ||
    !GIT_COMMIT_PATTERN.test(String(value.sources.bank)) ||
    !isRecord(value.updateMetadata) ||
    !hasExactOwnKeys(value.updateMetadata, ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) ||
    !Array.isArray(value.assets) ||
    value.assets.length === 0 ||
    value.assets.length > MAX_RELEASE_ASSETS
  ) {
    throw codedReleaseError('Desktop release manifest has an unsupported schema', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }

  const assets: Record<string, ApprovedReleaseAsset> = {};
  const manualTargets = expectedManualReleaseTargets(value.version);
  for (const asset of value.assets) {
    const expectedTarget = isRecord(asset) && typeof asset.name === 'string'
      ? manualTargets.get(asset.name)
      : undefined;
    if (
      !isRecord(asset) ||
      !hasExactOwnKeys(
        asset,
        expectedTarget
          ? ['name', 'size', 'sha256', 'sha512', 'target']
          : ['name', 'size', 'sha256', 'sha512'],
      ) ||
      typeof asset.name !== 'string' ||
      !RELEASE_ASSET_NAME_PATTERN.test(asset.name) ||
      Object.hasOwn(assets, asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      (asset.size as number) <= 0 ||
      (asset.size as number) > MAX_RELEASE_ASSET_BYTES ||
      typeof asset.sha256 !== 'string' ||
      !SHA256_PATTERN.test(asset.sha256) ||
      typeof asset.sha512 !== 'string' ||
      !isCanonicalSha512(asset.sha512) ||
      (expectedTarget === undefined && MANUAL_PACKAGE_NAME_PATTERN.test(asset.name)) ||
      (expectedTarget !== undefined && !exactReleaseTarget(asset.target, expectedTarget))
    ) {
      throw codedReleaseError('Desktop release manifest has an invalid asset inventory', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
    const githubAsset = githubAssets.get(asset.name);
    const expectedUrl = buildReleaseAssetUrl(expectedTag, asset.name);
    if (
      !githubAsset ||
      githubAsset.size !== asset.size ||
      githubAsset.browserDownloadUrl !== expectedUrl
    ) {
      throw codedReleaseError('Desktop release assets do not match the GitHub release', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
    assets[asset.name] = {
      name: asset.name,
      size: asset.size as number,
      sha256: asset.sha256,
      sha512: asset.sha512,
      downloadUrl: expectedUrl,
      ...(expectedTarget ? { target: expectedTarget } : {}),
    };
  }
  for (const expectedName of manualTargets.keys()) {
    if (!Object.hasOwn(assets, expectedName)) {
      throw codedReleaseError('Desktop release manifest is missing a supported manual package', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
  }

  const updateMetadata = {} as Record<'latest.yml' | 'latest-mac.yml' | 'latest-linux.yml', readonly string[]>;
  const expectedMetadata: Record<'latest.yml' | 'latest-mac.yml' | 'latest-linux.yml', readonly string[]> = {
    'latest.yml': [`QED2-${value.version}-win-x64.exe`],
    'latest-mac.yml': [
      `QED2-${value.version}-mac-arm64.zip`,
      `QED2-${value.version}-mac-x64.zip`,
    ],
    'latest-linux.yml': [
      `QED2-${value.version}-linux-x64.AppImage`,
      `QED2-${value.version}-linux-x64.deb`,
      `QED2-${value.version}-linux-x64.rpm`,
    ],
  };
  for (const key of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'] as const) {
    const names = value.updateMetadata[key];
    const expectedNames = expectedMetadata[key];
    if (
      !Array.isArray(names) ||
      names.length !== expectedNames.length ||
      names.some((name) => typeof name !== 'string' || !RELEASE_ASSET_NAME_PATTERN.test(name) || !assets[name]) ||
      names.some((name, index) => name !== expectedNames[index])
    ) {
      throw codedReleaseError('Desktop release manifest has invalid update metadata', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
    updateMetadata[key] = [...names] as string[];
  }

  return {
    tag: expectedTag,
    version: value.version,
    clientCommit: value.sources.client as string,
    coreCommit: value.sources.core as string,
    bankCommit: value.sources.bank as string,
    assets,
    updateMetadata,
  };
}

function parseGitHubAssets(value: unknown, expectedTag: string): Map<string, GitHubReleaseAsset> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RELEASE_ASSETS + 2) {
    throw codedReleaseError('GitHub Desktop release has an invalid asset inventory', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  const assets = new Map<string, GitHubReleaseAsset>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      !RELEASE_ASSET_NAME_PATTERN.test(item.name) ||
      !Number.isSafeInteger(item.size) ||
      (item.size as number) <= 0 ||
      typeof item.browser_download_url !== 'string' ||
      assets.has(item.name)
    ) {
      throw codedReleaseError('GitHub Desktop release has an invalid asset inventory', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
    const expectedUrl = buildReleaseAssetUrl(expectedTag, item.name);
    if (item.browser_download_url !== expectedUrl) {
      throw codedReleaseError('GitHub Desktop release asset URL escaped the approved repository', 'ERR_UPDATER_INVALID_RELEASE_FEED');
    }
    assets.set(item.name, {
      name: item.name,
      size: item.size as number,
      browserDownloadUrl: item.browser_download_url,
    });
  }
  return assets;
}

/** Reads only the immutable, public Desktop release channel; no repository token is accepted. */
export async function fetchApprovedDesktopRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<ApprovedDesktopRelease | undefined> {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'QED2-Desktop',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const response = await fetchImpl(
    `https://api.github.com/repos/${UPDATE_REPOSITORY_OWNER}/${UPDATE_REPOSITORY_NAME}/releases/latest`,
    { headers, signal: AbortSignal.timeout(12_000), cache: 'no-store', redirect: 'error' },
  );
  if (response.status === 404) return undefined;
  if (isRateLimitedResponse(response)) {
    throw codedReleaseError('GitHub Desktop release request was rate limited', 'ERR_UPDATER_RATE_LIMITED', response.status);
  }
  if (!response.ok) {
    throw codedReleaseError('GitHub Desktop release request failed', `HTTP_ERROR_${response.status}`, response.status);
  }
  const release = await readBoundedJson(response, MAX_RELEASE_API_BYTES, 'GitHub Desktop release response');
  if (
    !isRecord(release) ||
    typeof release.tag_name !== 'string' ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name) ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    throw codedReleaseError('GitHub Desktop release response has an unsupported schema', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  const githubAssets = parseGitHubAssets(release.assets, release.tag_name);
  const manifestAsset = githubAssets.get(RELEASE_MANIFEST_FILENAME);
  if (!manifestAsset) {
    throw codedReleaseError('GitHub Desktop release has no unique release manifest', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  const manifestUrl = new URL(manifestAsset.browserDownloadUrl);
  if (!isApprovedReleaseAssetUrl(manifestUrl, release.tag_name, RELEASE_MANIFEST_FILENAME)) {
    throw codedReleaseError('GitHub Desktop release manifest URL escaped the approved repository', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  const manifestResponse = await fetchApprovedReleaseUrl(manifestUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'QED2-Desktop' },
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  }, fetchImpl);
  if (isRateLimitedResponse(manifestResponse)) {
    throw codedReleaseError(
      'GitHub Desktop release manifest request was rate limited',
      'ERR_UPDATER_RATE_LIMITED',
      manifestResponse.status,
    );
  }
  if (!manifestResponse.ok) {
    throw codedReleaseError(
      'GitHub Desktop release manifest request failed',
      `HTTP_ERROR_${manifestResponse.status}`,
      manifestResponse.status,
    );
  }
  const approved = parseApprovedReleaseManifest(
    await readBoundedJson(manifestResponse, MAX_RELEASE_MANIFEST_BYTES, 'Desktop release manifest'),
    release.tag_name,
    githubAssets,
  );
  const expectedGitHubAssets = new Set([
    ...Object.keys(approved.assets),
    RELEASE_MANIFEST_FILENAME,
    'SHA256SUMS',
  ]);
  if (
    githubAssets.size !== expectedGitHubAssets.size ||
    [...githubAssets.keys()].some((name) => !expectedGitHubAssets.has(name))
  ) {
    throw codedReleaseError('GitHub Desktop release has unmanifested assets', 'ERR_UPDATER_INVALID_RELEASE_FEED');
  }
  return approved;
}

export const releaseFeedPatterns = {
  assetName: RELEASE_ASSET_NAME_PATTERN,
  sha256: SHA256_PATTERN,
  sha512: SHA512_BASE64_PATTERN,
  manualPackageName: MANUAL_PACKAGE_NAME_PATTERN,
  stableVersion: STABLE_VERSION_PATTERN,
  gitCommit: GIT_COMMIT_PATTERN,
} as const;
