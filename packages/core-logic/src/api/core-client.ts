/**
 * Client for qed2-core (content line, contract §3) — anonymous, read-only.
 * The client never sends user identity or server tokens to core (iron rule).
 */
import { normalizeBaseUrl } from '../config/index.js';
import type { Question } from '../model/question.js';
import type { CompetencyCatalog, CompetencyLocale } from '../model/competency-catalog.js';
import { parseCompetencyCatalog } from './competency-catalog.js';
import { requestJson } from './http.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { ApiError, CoreProtocolError } from './types.js';
import type {
  BatchResponse,
  ContentQuestion,
  CoreInfo,
  HealthResponse,
  ManifestAssetV2,
  ManifestQuestionV2,
  ManifestResponse,
  ManifestV2Response,
  QuestionsFilter,
  QuestionsListResponse,
  RecommendRequest,
  RecommendResponse,
  SearchResponse,
} from './types.js';

/** Contract §3.1: batch requests carry at most 200 ids each. */
export const BATCH_CHUNK_SIZE = 200;

/** Defensive bounds for the untrusted manifest map returned by Core. */
const MAX_MANIFEST_ITEMS = 10_000;
const MAX_MANIFEST_ASSETS = 10_000;
const MAX_QUESTION_ID_LENGTH = 256;
const MAX_BANK_PATH_LENGTH = 2_048;
const MAX_ASSET_KEY_LENGTH = 1_024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_QUESTION_ASSETS = 128;
const DANGEROUS_MANIFEST_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MANIFEST_V2_QUESTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export class CoreClient {
  private currentImmutableAssets: { commit: string; baseUrl: string } | undefined;

  constructor(private baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /** GET /content/questions — filter fields map 1:1 onto query params. */
  listQuestions(filter: QuestionsFilter = {}): Promise<QuestionsListResponse> {
    return requestJson<QuestionsListResponse>(this.baseUrl, '/content/questions', {
      query: {
        year: filter.year,
        term: filter.term,
        part: filter.part,
        suite: filter.suite,
        gk: filter.gk,
        kind: filter.kind,
        format: filter.format,
        status: filter.status,
        page: filter.page,
        pageSize: filter.pageSize,
      },
    });
  }

  /** GET /content/questions/:id, including Core's raw-bank contentHash. */
  async getQuestion(id: string): Promise<ContentQuestion> {
    const wire = await requestJson<Question & { contentHash?: unknown; wireHash?: unknown }>(
      this.baseUrl,
      `/content/questions/${encodeURIComponent(id)}`,
    );
    return splitContentQuestion(wire);
  }

  /**
   * POST /content/questions/batch — transparently chunks into requests of at
   * most BATCH_CHUNK_SIZE ids and merges `questions` + `missing` in order.
   */
  async getQuestionsBatch(ids: string[]): Promise<BatchResponse> {
    const questions: ContentQuestion[] = [];
    const missing: string[] = [];
    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
      const res = await requestJson<{
        questions: Array<Question & { contentHash?: unknown; wireHash?: unknown }>;
        missing: string[];
      }>(
        this.baseUrl,
        '/content/questions/batch', {
        method: 'POST',
        body: { ids: chunk },
      });
      questions.push(...res.questions.map(splitContentQuestion));
      missing.push(...res.missing);
    }
    return { questions, missing };
  }

  /** POST /content/recommend — stateless; userState comes from the caller. */
  recommend(req: RecommendRequest): Promise<RecommendResponse> {
    return requestJson<RecommendResponse>(this.baseUrl, '/content/recommend', {
      method: 'POST',
      body: req,
    });
  }

  /**
   * GET /content/search — fuzzy full-text search, relevance-ranked by core
   * (search upgrade doc; results must NOT be re-sorted client-side).
   * Empty/whitespace queries never reach the network.
   */
  search(q: string, opts: { limit?: number } = {}): Promise<SearchResponse> {
    const query = q.trim();
    if (query === '') {
      return Promise.resolve({ query: '', total: 0, items: [] });
    }
    return requestJson<SearchResponse>(this.baseUrl, '/content/search', {
      query: { q: query, limit: opts.limit },
    });
  }

  /** GET /content/info */
  info(): Promise<CoreInfo> {
    return requestJson<CoreInfo>(this.baseUrl, '/content/info');
  }

  /** A 404 alone means this Core/question bank predates the official catalog. */
  async getCompetencyCatalog(locale: CompetencyLocale): Promise<CompetencyCatalog | null> {
    if (locale !== 'de' && locale !== 'en') throw new TypeError('Unsupported competency locale');
    try {
      return parseCompetencyCatalog(await requestJson<unknown>(
        this.baseUrl, `/content/competencies/${locale}`, { timeoutMs: 10_000 },
      ), locale);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return null;
      throw cause;
    }
  }

  /**
   * Prefer the authenticated current-bank Manifest v2. A 404 alone is the
   * compatibility signal for a pre-2.2 Core; malformed v2 responses, service
   * errors and network failures are never silently downgraded to v1.
   */
  async manifest(): Promise<ManifestResponse> {
    try {
      const parsed = parseManifestV2(
        await requestJson<unknown>(this.baseUrl, '/content/manifest/v2'),
      );
      this.currentImmutableAssets = {
        commit: parsed.commit,
        baseUrl: parsed.bank.immutableAssetBaseUrl,
      };
      return parsed;
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
    }

    const legacy = parseManifestResponse(
      await requestJson<unknown>(this.baseUrl, '/content/manifest'),
    );
    this.currentImmutableAssets = undefined;
    return legacy;
  }

  /** Immutable manifest from Core's trusted revision vault. */
  revisionManifest(commit: string): Promise<ManifestResponse> {
    const revision = revisionCommit(commit);
    return requestJson<unknown>(
      this.baseUrl,
      `/content/revisions/${revision}/manifest`,
    ).then((wire) => parseManifestResponse(wire, revision));
  }

  /** One exact historical question, with the same integrity metadata as live content. */
  async getRevisionQuestion(commit: string, id: string): Promise<ContentQuestion> {
    const wire = await requestJson<Question & { contentHash?: unknown; wireHash?: unknown }>(
      this.baseUrl,
      `/content/revisions/${revisionCommit(commit)}/questions/${encodeURIComponent(id)}`,
    );
    return splitContentQuestion(wire);
  }

  /** Historical batch endpoint, preserving the normal 200-id transport bound. */
  async getRevisionQuestionsBatch(commit: string, ids: string[]): Promise<BatchResponse> {
    const revision = revisionCommit(commit);
    const questions: ContentQuestion[] = [];
    const missing: string[] = [];
    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
      const res = await requestJson<{
        questions: Array<Question & { contentHash?: unknown; wireHash?: unknown }>;
        missing: string[];
      }>(this.baseUrl, `/content/revisions/${revision}/questions/batch`, {
        method: 'POST',
        body: { ids: chunk },
      });
      questions.push(...res.questions.map(splitContentQuestion));
      missing.push(...res.missing);
    }
    return { questions, missing };
  }

  /** GET /content/health */
  health(): Promise<HealthResponse> {
    return requestJson<HealthResponse>(this.baseUrl, '/content/health');
  }

  /**
   * Resolve a bank-relative figure `src` to a fetchable URL.
   *
   * Contract §3.4: `GET /content/assets/*path` serves the bank's `assets/`
   * subtree, and its own example resolves `assets/pdf/.../x.png` as
   * `GET /content/assets/pdf/.../x.png` — i.e. *path is relative to the
   * `assets/` directory, not the bank root. Verified against the live core:
   * the doubled form `/content/assets/assets/...` returns 404. A leading
   * `assets/` on `src` is therefore stripped before joining.
   */
  assetUrl(src: string, contentId?: string): string {
    const relative = src.replace(/^\/+/, '').replace(/^assets\//, '');
    // Encode each segment but keep '/' separators intact.
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    const immutable = this.currentImmutableAssets;
    if (immutable && (contentId === undefined || contentId === immutable.commit)) {
      return `${this.baseUrl}${immutable.baseUrl}/${encoded}`;
    }
    const url = `${this.baseUrl}/content/assets/${encoded}`;
    // Core's asset controller ignores query parameters, while browser/PWA
    // caches include them in the cache key. A revision key therefore prevents
    // Workbox's long-lived CacheFirst entry from pairing old bytes with a new
    // question payload; callers still perform a manifest sandwich because the
    // upstream route itself is mutable.
    return contentId ? `${url}?qed2-content=${encodeURIComponent(contentId)}` : url;
  }

  /** Immutable asset URL for an exact catalogued bank revision. */
  revisionAssetUrl(src: string, commit: string): string {
    const relative = src.replace(/^\/+/, '').replace(/^assets\//, '');
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/content/revisions/${revisionCommit(commit)}/assets/${encoded}`;
  }
}

function parseManifestV2(wire: unknown): ManifestV2Response {
  if (!isPlainObject(wire) || wire.formatVersion !== 2 || wire.wireContractVersion !== 1) {
    throw invalidManifest('Core returned an unsupported Manifest v2 format.');
  }
  if (!isPlainObject(wire.bank) || !isFullLowercaseCommit(wire.bank.commit)) {
    throw invalidManifest('Core returned an invalid Manifest v2 bank commit.');
  }
  const commit = wire.bank.commit;
  if (
    !isLowercaseSha256(wire.bank.rootSha256)
    || !isPlainObject(wire.bank.schema)
    || wire.bank.schema.path !== 'schema/question.ts'
    || !isLowercaseSha256(wire.bank.schema.sha256)
    || wire.bank.immutableAssetBaseUrl !== `/content/banks/${commit}/assets`
  ) {
    throw invalidManifest('Core returned invalid Manifest v2 bank metadata.');
  }
  if (!isPlainObject(wire.questions) || !isPlainObject(wire.assets)) {
    throw invalidManifest('Core returned invalid Manifest v2 inventories.');
  }

  const questionEntries = Object.entries(wire.questions);
  const assetEntries = Object.entries(wire.assets);
  if (questionEntries.length > MAX_MANIFEST_ITEMS || assetEntries.length > MAX_MANIFEST_ASSETS) {
    throw invalidManifest('Core returned an oversized Manifest v2 inventory.');
  }

  const assets = Object.create(null) as Record<string, ManifestAssetV2>;
  for (const [key, value] of assetEntries) {
    if (DANGEROUS_MANIFEST_KEYS.has(key) || !isSafeAssetKey(key) || !isPlainObject(value)) {
      throw invalidManifest('Core returned an invalid asset in Manifest v2.');
    }
    if (
      value.path !== `assets/${key}`
      || !Number.isSafeInteger(value.bytes)
      || (value.bytes as number) <= 0
      || (value.bytes as number) > MAX_ASSET_BYTES
      || value.mimeType !== 'image/png'
      || !isLowercaseSha256(value.sha256)
    ) {
      throw invalidManifest('Core returned invalid asset metadata in Manifest v2.');
    }
    assets[key] = {
      path: value.path,
      bytes: value.bytes as number,
      mimeType: value.mimeType,
      sha256: value.sha256,
    };
  }

  const questions = Object.create(null) as Record<string, ManifestQuestionV2>;
  const items = Object.create(null) as Record<string, string>;
  for (const [questionId, value] of questionEntries) {
    if (
      DANGEROUS_MANIFEST_KEYS.has(questionId)
      || !MANIFEST_V2_QUESTION_ID_PATTERN.test(questionId)
      || !isPlainObject(value)
      || !isQuestionPath(value.path, questionId)
      || !isLowercaseSha256(value.rawSha256)
      || !isLowercaseSha256(value.wireSha256)
      || !Array.isArray(value.assets)
      || value.assets.length > MAX_QUESTION_ASSETS
    ) {
      throw invalidManifest('Core returned invalid question metadata in Manifest v2.');
    }
    const questionAssets: string[] = [];
    const seenAssets = new Set<string>();
    for (const asset of value.assets) {
      if (
        typeof asset !== 'string'
        || !isSafeAssetKey(asset)
        || !Object.prototype.hasOwnProperty.call(assets, asset)
        || seenAssets.has(asset)
      ) {
        throw invalidManifest('Core returned invalid question assets in Manifest v2.');
      }
      questionAssets.push(asset);
      seenAssets.add(asset);
    }
    questions[questionId] = {
      path: value.path,
      rawSha256: value.rawSha256,
      wireSha256: value.wireSha256,
      assets: questionAssets,
    };
    items[questionId] = value.rawSha256;
  }

  const schema = {
    path: 'schema/question.ts' as const,
    sha256: wire.bank.schema.sha256,
  };
  const rootSha256 = bytesToHex(sha256(utf8ToBytes(canonicalJson({
    wireContractVersion: 1,
    schema,
    questions,
    assets,
  }))));
  if (rootSha256 !== wire.bank.rootSha256) {
    throw invalidManifest('Core returned a Manifest v2 root that does not match its inventory.');
  }

  return {
    commit,
    items,
    formatVersion: 2,
    wireContractVersion: 1,
    bank: {
      commit,
      rootSha256,
      schema,
      immutableAssetBaseUrl: wire.bank.immutableAssetBaseUrl,
    },
    questions,
    assets,
  };
}

function revisionCommit(commit: string): string {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new TypeError('revision commit must be a full lowercase Git SHA');
  }
  return commit;
}

function parseManifestResponse(wire: unknown, expectedCommit?: string): ManifestResponse {
  if (!isPlainObject(wire) || !isFullLowercaseCommit(wire.commit)) {
    throw invalidManifest('Core returned an invalid manifest commit.');
  }
  if (expectedCommit !== undefined && wire.commit !== expectedCommit) {
    throw invalidManifest('Core returned a manifest for a different revision.');
  }
  if (!isPlainObject(wire.items)) {
    throw invalidManifest('Core returned an invalid manifest items map.');
  }

  const entries = Object.entries(wire.items);
  if (entries.length > MAX_MANIFEST_ITEMS) {
    throw invalidManifest('Core returned too many manifest items.');
  }
  for (const [questionId, hash] of entries) {
    if (DANGEROUS_MANIFEST_KEYS.has(questionId) || !isQuestionId(questionId)) {
      throw invalidManifest('Core returned an invalid question id in its manifest.');
    }
    if (!isLowercaseSha256(hash)) {
      throw invalidManifest('Core returned an invalid question hash in its manifest.');
    }
  }

  const items = Object.create(null) as Record<string, string>;
  for (const [questionId, hash] of entries) items[questionId] = hash as string;
  return { commit: wire.commit, items };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFullLowercaseCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isQuestionId(value: string): boolean {
  return value.length <= MAX_QUESTION_ID_LENGTH && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isQuestionPath(value: unknown, questionId: string): value is string {
  if (typeof value !== 'string' || value.length > MAX_BANK_PATH_LENGTH) return false;
  if (!isSafeRelativePath(value) || !value.startsWith('content/')) return false;
  const segments = value.split('/');
  return segments.length >= 3 && segments.at(-1) === `${questionId}.json`;
}

function isSafeAssetKey(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_ASSET_KEY_LENGTH
    && isSafeRelativePath(value);
}

function isSafeRelativePath(value: string): boolean {
  return !value.includes('\\')
    && !value.includes('\0')
    && !value.startsWith('/')
    && value.split('/').every((segment) => (
      segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.')
    ));
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function invalidManifest(message: string): CoreProtocolError {
  return new CoreProtocolError('CORE_MANIFEST_INVALID', message);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

function splitContentQuestion(
  wire: Question & { contentHash?: unknown; wireHash?: unknown },
): ContentQuestion {
  if (!wire || typeof wire !== 'object') {
    throw new CoreProtocolError('CORE_QUESTION_INVALID', 'Core returned an invalid question payload.');
  }
  const { contentHash, wireHash, ...question } = wire;
  if (!isSha256(contentHash) || !isSha256(wireHash)) {
    throw new CoreProtocolError(
      'CORE_CONTENT_HASH_MISSING',
      'Core did not provide the required contentHash and wireHash metadata.',
    );
  }
  return {
    question: question as Question,
    contentHash,
    wireHash,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
