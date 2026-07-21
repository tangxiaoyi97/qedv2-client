/**
 * Client for qed2-core (content line, contract §3) — anonymous, read-only.
 * The client never sends user identity or server tokens to core (iron rule).
 */
import { normalizeBaseUrl } from '../config/index.js';
import type { Question } from '../model/question.js';
import { requestJson } from './http.js';
import type {
  BatchResponse,
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

  /** GET /content/questions/:id */
  getQuestion(id: string): Promise<Question> {
    return requestJson<Question>(this.baseUrl, `/content/questions/${encodeURIComponent(id)}`);
  }

  /**
   * POST /content/questions/batch — transparently chunks into requests of at
   * most BATCH_CHUNK_SIZE ids and merges `questions` + `missing` in order.
   */
  async getQuestionsBatch(ids: string[]): Promise<BatchResponse> {
    const questions: Question[] = [];
    const missing: string[] = [];
    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
      const res = await requestJson<BatchResponse>(this.baseUrl, '/content/questions/batch', {
        method: 'POST',
        body: { ids: chunk },
      });
      questions.push(...res.questions);
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
    return requestJson<ManifestResponse>(this.baseUrl, '/content/manifest');
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
  assetUrl(src: string): string {
    const relative = src.replace(/^\/+/, '').replace(/^assets\//, '');
    // Encode each segment but keep '/' separators intact.
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/content/assets/${encoded}`;
  }
}
