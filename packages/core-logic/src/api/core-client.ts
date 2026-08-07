/**
 * Client for qed2-core (content line, contract §3) — anonymous, read-only.
 * The client never sends user identity or server tokens to core (iron rule).
 */
import { normalizeBaseUrl } from '../config/index.js';
import type { Question } from '../model/question.js';
import { requestJson } from './http.js';
import { CoreProtocolError } from './types.js';
import type {
  BatchResponse,
  ContentQuestion,
  CoreInfo,
  HealthResponse,
  ManifestResponse,
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
const MAX_QUESTION_ID_LENGTH = 256;
const DANGEROUS_MANIFEST_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class CoreClient {
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

  /** GET /content/manifest */
  manifest(): Promise<ManifestResponse> {
    return requestJson<unknown>(this.baseUrl, '/content/manifest').then((wire) =>
      parseManifestResponse(wire),
    );
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

  return { commit: wire.commit, items: wire.items as Record<string, string> };
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

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function invalidManifest(message: string): CoreProtocolError {
  return new CoreProtocolError('CORE_MANIFEST_INVALID', message);
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
