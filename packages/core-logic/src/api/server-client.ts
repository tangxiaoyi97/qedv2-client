/**
 * Client for qed2-server (user line, contract §2/§4/§5).
 *
 * The token is pulled from `tokenProvider` per request (never cached here) so
 * refreshes propagate automatically. When the provider yields no token the
 * request is sent unauthenticated and the server's 401 envelope surfaces as
 * an ApiError — auth state is not pre-validated client-side.
 *
 * Structurally satisfies the sync-engine's SyncTransport ({getState, sync,
 * resolve}) without importing it.
 */
import { normalizeBaseUrl } from '../config/index.js';
import { requestJson, type RequestOptions } from './http.js';
import type {
  AttemptRecord,
  AuthResponse,
  HealthResponse,
  HistoryQuery,
  HistoryResponse,
  LeaderboardDetail,
  LeaderboardPeriod,
  LeaderboardProfile,
  LeaderboardResponse,
  RefreshResponse,
  ResolveRequest,
  ResolveResponse,
  ServerArchiveState,
  ServerInfo,
  SyncRequest,
  SyncResponse,
  UserInfo,
} from './types.js';

export class ServerClient {
  constructor(
    private baseUrl: string,
    private tokenProvider: () => string | undefined = () => undefined,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /** Attach the current token if there is one (key omitted otherwise). */
  private authed(opts: RequestOptions): RequestOptions {
    const token = this.tokenProvider();
    return token === undefined ? opts : { ...opts, token };
  }

  /** POST /auth/login — deliberately unauthenticated. */
  login(username: string, password: string): Promise<AuthResponse> {
    return requestJson<AuthResponse>(this.baseUrl, '/auth/login', {
      method: 'POST',
      body: { username, password },
    });
  }

  /** POST /auth/redeem — invite-code account creation, unauthenticated. */
  redeem(inviteCode: string, username: string, password: string): Promise<AuthResponse> {
    return requestJson<AuthResponse>(this.baseUrl, '/auth/redeem', {
      method: 'POST',
      body: { inviteCode, username, password },
    });
  }

  /** POST /auth/refresh */
  refresh(): Promise<RefreshResponse> {
    return requestJson<RefreshResponse>(this.baseUrl, '/auth/refresh', this.authed({ method: 'POST' }));
  }

  /** GET /auth/me */
  me(): Promise<UserInfo> {
    return requestJson<UserInfo>(this.baseUrl, '/auth/me', this.authed({}));
  }

  /** GET /me/state */
  getState(): Promise<ServerArchiveState> {
    return requestJson<ServerArchiveState>(this.baseUrl, '/me/state', this.authed({}));
  }

  /** POST /me/sync — the ONLY progress write path (contract §0/§5). */
  sync(req: SyncRequest): Promise<SyncResponse> {
    return requestJson<SyncResponse>(this.baseUrl, '/me/sync', this.authed({ method: 'POST', body: req }));
  }

  /** POST /me/sync/resolve */
  resolve(req: ResolveRequest): Promise<ResolveResponse> {
    return requestJson<ResolveResponse>(
      this.baseUrl,
      '/me/sync/resolve',
      this.authed({ method: 'POST', body: req }),
    );
  }

  /** POST /me/attempts — optional audit-only stream (contract §4.2). */
  recordAttempts(attempts: AttemptRecord[]): Promise<{ recorded: number }> {
    return requestJson<{ recorded: number }>(
      this.baseUrl,
      '/me/attempts',
      this.authed({ method: 'POST', body: { attempts } }),
    );
  }

  /**
   * GET /me/history — read-only, paginated view over the attempt audit trail
   * (newest gradedAt first; identifiers only, never question content).
   * The client joins titles etc. from core / its question cache.
   */
  getHistory(query: HistoryQuery = {}): Promise<HistoryResponse> {
    return requestJson<HistoryResponse>(
      this.baseUrl,
      '/me/history',
      this.authed({
        query: {
          since: query.since,
          until: query.until,
          page: query.page,
          pageSize: query.pageSize,
          partId: query.partId,
          questionId: query.questionId,
        },
      }),
    );
  }

  /** GET /leaderboard — authenticated, opt-in aggregate rankings. */
  getLeaderboard(
    query: { period?: LeaderboardPeriod; page?: number; pageSize?: number } = {},
  ): Promise<LeaderboardResponse> {
    return requestJson<LeaderboardResponse>(
      this.baseUrl,
      '/leaderboard',
      this.authed({
        query: {
          period: query.period,
          page: query.page,
          pageSize: query.pageSize,
        },
      }),
    );
  }

  /** GET /leaderboard/users/:profileId — public aggregates, still auth-only. */
  getLeaderboardDetail(profileId: string): Promise<LeaderboardDetail> {
    return requestJson<LeaderboardDetail>(
      this.baseUrl,
      `/leaderboard/users/${encodeURIComponent(profileId)}`,
      this.authed({}),
    );
  }

  /** GET /me/leaderboard-profile */
  getLeaderboardProfile(): Promise<LeaderboardProfile> {
    return requestJson<LeaderboardProfile>(
      this.baseUrl,
      '/me/leaderboard-profile',
      this.authed({}),
    );
  }

  /** PUT joins the leaderboard or updates the current public nickname. */
  saveLeaderboardProfile(nickname: string): Promise<Extract<LeaderboardProfile, { participating: true }>> {
    return requestJson<Extract<LeaderboardProfile, { participating: true }>>(
      this.baseUrl,
      '/me/leaderboard-profile',
      this.authed({ method: 'PUT', body: { nickname } }),
    );
  }

  /** DELETE immediately removes the current user from public rankings. */
  leaveLeaderboard(): Promise<{ participating: false }> {
    return requestJson<{ participating: false }>(
      this.baseUrl,
      '/me/leaderboard-profile',
      this.authed({ method: 'DELETE' }),
    );
  }

  /** GET /info */
  info(): Promise<ServerInfo> {
    return requestJson<ServerInfo>(this.baseUrl, '/info');
  }

  /** GET /health */
  health(): Promise<HealthResponse> {
    return requestJson<HealthResponse>(this.baseUrl, '/health');
  }
}
