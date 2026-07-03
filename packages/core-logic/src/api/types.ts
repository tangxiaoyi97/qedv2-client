/**
 * Wire types for both services, derived from the contract (§3 core, §4–5
 * server) and verified against the real running services.
 */
import type { AnswerKind, Question, QuestionSummary, Term, ExamPart } from '../model/question.js';
import type { ArchiveContent, PartEntry, CompetencyEntry, ServerArchiveState } from '../model/archive.js';

/* ================================================================== *
 * Shared error envelope (contract §7.2)
 * ================================================================== */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Thrown by both clients on non-2xx responses. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown on network-level failures (offline, DNS, CORS). */
export class NetworkError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/* ================================================================== *
 * qed2-core (content line) — all anonymous, all read-only
 * ================================================================== */

export interface QuestionsFilter {
  year?: number;
  term?: Term;
  part?: ExamPart;
  suite?: string;
  /** Competency code, e.g. "AN 4.3". */
  gk?: string;
  kind?: AnswerKind;
  format?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface QuestionsListResponse {
  items: QuestionSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BatchResponse {
  questions: Question[];
  missing: string[];
}

export interface RecommendUserState {
  perPart: Pick<PartEntry, 'partId' | 'fsrs'>[];
  perCompetency: Pick<CompetencyEntry, 'code' | 'mastery'>[];
}

export interface RecommendRequest {
  userState: RecommendUserState | Record<string, never>;
  filters?: QuestionsFilter;
  count?: number;
  strategy?: 'smart-review';
}

export type RecommendReason = 'due-review' | 'weak-competency' | 'coldstart';

export interface RecommendItem {
  questionId: string;
  partId: string;
  reason: RecommendReason;
}

export interface RecommendResponse {
  items: RecommendItem[];
  strategy: string;
}

export interface CoreInfo {
  service: string;
  version: string;
  schemaVersionSupported: { min: number; max: number };
  bank: {
    repo: string;
    branch: string;
    commit: string;
    questionCount: number;
    playableCount: number;
  };
  sourceRepo: string;
  buildTime: string;
}

export interface ManifestResponse {
  commit: string;
  items: Record<string, string>;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  db?: string;
}

/* ================================================================== *
 * qed2-server (user line)
 * ================================================================== */

export interface UserInfo {
  id: string;
  username: string;
}

export interface AuthResponse {
  token: string;
  expiresAt: string;
  user: UserInfo;
}

export interface RefreshResponse {
  token: string;
  expiresAt: string;
}

export interface SyncRequest {
  baseVersion: number;
  localArchive: ArchiveContent;
}

export interface SyncFastForward {
  result: 'fast-forward';
  archiveVersion: number;
  checksum: string;
}

export interface SyncMerged {
  result: 'merged';
  archiveVersion: number;
  checksum: string;
  mergedArchive: ArchiveContent;
  mergeSummary?: { fromServer: number; fromLocal: number; unchanged: number };
}

export interface PartConflict {
  partId: string;
  server: PartEntry;
  local: PartEntry;
}

export interface CompetencyConflict {
  competencyCode: string;
  server: CompetencyEntry;
  local: CompetencyEntry;
}

/** Mixed conflict list, exactly as the server emits it. */
export type ConflictEntry = PartConflict | CompetencyConflict;

export function isPartConflict(c: ConflictEntry): c is PartConflict {
  return 'partId' in c;
}

export interface SyncConflict {
  result: 'conflict';
  serverVersion: number;
  serverChecksum: string;
  conflicts: ConflictEntry[];
  /** Merge result for everything that was NOT in conflict. */
  autoMergeable: ArchiveContent;
}

export type SyncResponse = SyncFastForward | SyncMerged | SyncConflict;

export interface ResolveRequest {
  baseServerVersion: number;
  resolvedArchive: ArchiveContent;
}

export interface ResolveOk {
  result: 'resolved';
  archiveVersion: number;
  checksum: string;
}

export type ResolveResponse = ResolveOk | SyncConflict;

export interface AttemptRecord {
  questionId: string;
  partId: string;
  correct: boolean;
  awardedPoints: number;
  elapsedMs?: number;
  gradedAt: string;
}

export interface ServerInfo {
  service: string;
  version: string;
  sourceRepo: string;
  buildTime: string;
  auth: string;
}

export type { ServerArchiveState };
