/**
 * Practice session store — drives the practice flow:
 * recommend (or explicit selection) → fetch full questions → per-part
 * answer/grade cycle → archive updates → periodic sync.
 *
 * Grading supplement: excluded parts are filtered OUT of every session
 * source (they are also projected away in the recommend userState); manual
 * grading overrides rebase FSRS on the pre-answer snapshot kept per part.
 */
import { defineStore } from 'pinia';
import { useI18n } from '../i18n.js';
import { computed, ref, shallowRef } from 'vue';
import {
  CoreClient,
  CoreProtocolError,
  deterministicAiRequestId,
  GUEST_ATTEMPT_OWNER,
  hasAtomicStorage,
  historyEventRowKey,
  isGrading,
  isLocalProfileId,
  parseStoredHistoryEvent,
  questionContentHash,
  STORAGE,
  submittedText as projectSubmittedText,
} from '@qed2/core-logic';
import type {
  AttemptOwnerSnapshot,
  ContentQuestion,
  CoreSourcePreference,
  FsrsState,
  GradeResult,
  Grading,
  LocalProfileId,
  ManifestAssetV2,
  ManifestResponse,
  Question,
  QuestionPart,
  QuestionsFilter,
  RecommendReason,
  Submission,
  QueuedAttempt,
  LearningHintLevel,
  LearningEvent,
  AiDiagnosisCode,
  AiExplainCacheLocator,
  AiAssessCacheLocator,
  SelfAssessment,
} from '@qed2/core-logic';
import {
  attemptOutbox,
  learningEventStore,
  localProfileStore,
  ports,
  questionCache,
  storage,
} from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';
import { useProgressStore } from './progress.js';

const { t } = useI18n();

/** Sync after every N graded parts while logged in (brief §5: sync eagerly). */
const SYNC_EVERY_N_GRADES = 3;
/**
 * A hand-picked set is an ad-hoc thing; resurrecting a week-old one is more
 * surprise than convenience. A programme is bounded by the day instead — see
 * `isResumable`.
 */
const MANUAL_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Grace for a programme that straddles midnight. Strict same-day alone would
 * throw away a session started at 23:50 the moment the user came back ten
 * minutes later — technically a new day, obviously the same sitting.
 */
const SMART_SESSION_GRACE_MS = 6 * 60 * 60 * 1000;
const SESSION_STORAGE_KEY = 'practice-session';
const SESSION_STORAGE_VERSION = 6;
const SESSION_PROFILE_KEY_VERSION = 1;
const MAX_PINNED_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_ASSET_BYTES = 32 * 1024 * 1024;
const ASSET_REQUEST_TIMEOUT_MS = 12_000;
const ASSET_RETRY_DELAY_MS = 350;
const MAX_ASSET_RETRY_DELAY_MS = 2_000;
const RETRYABLE_ASSET_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Where a session came from. „Programm üben" in the navigation means the
 * FSRS programme for today; a hand-picked set from the Aufgaben list is a
 * different thing that happens to use the same screen. Without this tag the
 * two are indistinguishable once the session is running, and the plain
 * /practice entry silently resumed whichever set was last open.
 */
export type SessionOrigin = 'smart' | 'manual';

export interface SessionItem {
  questionId: string;
  partId: string;
  reason: RecommendReason | 'manual';
  /** Stable across a crash/reload so paid AI retries keep one interaction. */
  learningInteractionId?: string;
  /** Reserved with the item so two windows share one logical grade commit. */
  clientAttemptId?: string;
  deliveredHintLevel?: LearningHintLevel;
  /** @deprecated v6 compatibility; new snapshots keep each learning mode separately. */
  cachedAiHelp?: AiExplainCacheLocator;
  /** Opaque pointer only; paid response text remains exclusively in AiCache. */
  cachedAiHint?: AiExplainCacheLocator;
  cachedAiDiagnosis?: AiExplainCacheLocator;
  /** Opaque pointer to a paid self-assessment comparison. */
  cachedAiAssessment?: AiAssessCacheLocator;
  /** Durable pre-answer mastery pick; null is a revisioned tombstone. */
  pendingGrading?: { grading: Grading | null; savedAt: string };
  /** Local-only first-answer draft; missing submission is a revisioned tombstone. */
  answerDraft?: { revision: number; submission?: Submission; savedAt: string };
}

export interface GradedRecord {
  clientAttemptId: string;
  partId: string;
  questionId: string;
  result: GradeResult;
  reason: SessionItem['reason'];
  gradedAt: string;
  elapsedMs: number;
  hintLevel?: LearningHintLevel;
  correctionOutcome?: GradeResult['verdict'];
  correctedAt?: string;
  /** User deliberately continued without a correction. */
  correctionClosedAt?: string;
  /** Local-only while one correction is open; never synced or learned from. */
  pendingSubmission?: Submission;
  /** Local-only edits made during the one correction, with a CAS merge clock. */
  correctionDraft?: { submission: Submission; savedAt: string };
  /** Allows a post-reload manual choice to replace this exact review. */
  gradingBaseCaptured?: true;
  preAnswerFsrs?: FsrsState;
}

export type AnswerDraftSaveOutcome =
  | { status: 'saved' }
  | { status: 'superseded-by-grade'; record: GradedRecord }
  | { status: 'failed' };

export interface SelfAssessmentDraft {
  version: 1;
  revision: number;
  partId: string;
  submission: Submission;
  assessment: SelfAssessment;
  selectedPoints: number | null;
  grading: Grading | null;
  indeterminate: boolean;
  indeterminateMax: number;
  savedAt: string;
}

interface PersistedPracticeSession {
  version: 2 | 3 | 4 | 5 | typeof SESSION_STORAGE_VERSION;
  /** Added in v3; v2 is migrated using the owner of the key being read. */
  owner?: AttemptOwnerSnapshot;
  /** Added in v4; older/malformed sessions require an explicit current-bank choice. */
  contentSource?: CoreSourcePreference;
  /** Immutable bank revision used to validate an offline resume. */
  contentId?: string;
  origin: SessionOrigin;
  items: SessionItem[];
  index: number;
  graded: GradedRecord[];
  /** Account-scoped local-only draft; never projected outside app storage. */
  selfAssessmentDraft?: SelfAssessmentDraft;
  /** Monotonic tombstone prevents stale windows from resurrecting a cleared draft. */
  draftRevision?: number;
  savedAt: string;
}

interface AnswerDraftWriteIntent {
  owner: AttemptOwnerSnapshot;
  key: string;
  partId: string;
  itemIdentity: string;
  submission: Submission;
  snapshot: PersistedPracticeSession;
}

interface AnswerDraftWritePipeline {
  latest?: AnswerDraftWriteIntent;
  waiters: Array<(outcome: AnswerDraftSaveOutcome) => void>;
}

function isPersistedPracticeSession(value: unknown): value is PersistedPracticeSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedPracticeSession>;
  return (candidate.version === 2
    || candidate.version === 3
    || candidate.version === 4
    || candidate.version === 5
    || candidate.version === SESSION_STORAGE_VERSION)
    && (candidate.version === 2
      || (candidate.owner !== undefined
        && typeof candidate.owner.userId === 'string'
        && (candidate.owner.guestGeneration === undefined
          || typeof candidate.owner.guestGeneration === 'string')
        && (candidate.owner.localProfileId === undefined
          || isLocalProfileId(candidate.owner.localProfileId))))
    && (candidate.version !== SESSION_STORAGE_VERSION
      || isLocalProfileId(candidate.owner?.localProfileId))
    && (candidate.version < 4
      || ((candidate.contentSource === undefined
        || candidate.contentSource === 'local'
        || candidate.contentSource === 'remote')
        && (candidate.contentId === undefined || typeof candidate.contentId === 'string')))
    && (candidate.origin === 'smart' || candidate.origin === 'manual')
    && Array.isArray(candidate.items)
    && candidate.items.every((item) =>
      item
      && typeof item === 'object'
      && typeof item.questionId === 'string'
      && typeof item.partId === 'string'
      && typeof item.reason === 'string'
      && (item.learningInteractionId === undefined
        || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.learningInteractionId))
      && (item.clientAttemptId === undefined
        || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.clientAttemptId))
      && (item.deliveredHintLevel === undefined
        || item.deliveredHintLevel === 1
        || item.deliveredHintLevel === 2
        || item.deliveredHintLevel === 3)
      && (item.cachedAiHelp === undefined || isAiExplainCacheLocator(item.cachedAiHelp))
      && (item.cachedAiHint === undefined
        || (isAiExplainCacheLocator(item.cachedAiHint) && item.cachedAiHint.mode === 'hint'))
      && (item.cachedAiDiagnosis === undefined
        || (isAiExplainCacheLocator(item.cachedAiDiagnosis) && item.cachedAiDiagnosis.mode === 'diagnosis'))
      && (item.cachedAiAssessment === undefined || isAiAssessCacheLocator(item.cachedAiAssessment))
      && (item.pendingGrading === undefined || isPendingGrading(item.pendingGrading))
      && (item.answerDraft === undefined || isAnswerDraft(item.answerDraft)))
    && typeof candidate.index === 'number'
    && Number.isInteger(candidate.index)
    && candidate.index >= 0
    && typeof candidate.savedAt === 'string'
    && (candidate.draftRevision === undefined
      || (Number.isSafeInteger(candidate.draftRevision) && candidate.draftRevision >= 0))
    && (candidate.selfAssessmentDraft === undefined
      || isSelfAssessmentDraft(candidate.selfAssessmentDraft))
    && (candidate.selfAssessmentDraft === undefined
      || candidate.selfAssessmentDraft.revision === candidate.draftRevision)
    && Array.isArray(candidate.graded)
    && candidate.graded.every((record) =>
      record
      && typeof record === 'object'
      && typeof record.clientAttemptId === 'string'
      && typeof record.partId === 'string'
      && typeof record.questionId === 'string'
      && typeof record.reason === 'string'
      && typeof record.gradedAt === 'string'
      && typeof record.elapsedMs === 'number'
      && (record.hintLevel === undefined
        || record.hintLevel === 1
        || record.hintLevel === 2
        || record.hintLevel === 3)
      && (record.correctionOutcome === undefined
        || record.correctionOutcome === 'incorrect'
        || record.correctionOutcome === 'partial'
        || record.correctionOutcome === 'correct')
      && (record.correctedAt === undefined
        || (typeof record.correctedAt === 'string' && !Number.isNaN(Date.parse(record.correctedAt))))
      && (record.correctionClosedAt === undefined
        || (typeof record.correctionClosedAt === 'string' && !Number.isNaN(Date.parse(record.correctionClosedAt))))
      && (record.pendingSubmission === undefined || isPersistableSubmission(record.pendingSubmission))
      && (record.correctionDraft === undefined
        || (record.correctionDraft
          && typeof record.correctionDraft === 'object'
          && !Array.isArray(record.correctionDraft)
          && Object.keys(record.correctionDraft).every((key) => key === 'submission' || key === 'savedAt')
          && isPersistableSubmission(record.correctionDraft.submission)
          && typeof record.correctionDraft.savedAt === 'string'
          && !Number.isNaN(Date.parse(record.correctionDraft.savedAt))))
      && (record.gradingBaseCaptured === undefined || record.gradingBaseCaptured === true)
      && (record.preAnswerFsrs === undefined || isFsrsState(record.preAnswerFsrs))
      && record.result
      && typeof record.result === 'object'
      && typeof record.result.verdict === 'string'
      && typeof record.result.correct === 'boolean'
      && typeof record.result.awardedPoints === 'number'
      && typeof record.result.maxPoints === 'number');
}

/** A persisted session may resume automatically only with complete provenance. */
function hasExactContentProvenance(
  snapshot: PersistedPracticeSession,
): snapshot is PersistedPracticeSession & {
  version: typeof SESSION_STORAGE_VERSION;
  contentSource: CoreSourcePreference;
  contentId: string;
} {
  return snapshot.version === SESSION_STORAGE_VERSION
    && (snapshot.contentSource === 'local' || snapshot.contentSource === 'remote')
    && typeof snapshot.contentId === 'string'
    && /^[0-9a-f]{40}$/u.test(snapshot.contentId);
}

/**
 * Durable practice-session address. The local profile — not the current auth
 * token or the generic word "guest" — is the ownership boundary. A rotated
 * guest therefore receives a different key, while a route created by invite
 * registration can still make the old profile readable by its destination.
 */
export function practiceSessionStorageKey(
  profileId: LocalProfileId,
  windowKind?: string,
): string {
  if (!isLocalProfileId(profileId)) throw new TypeError('Invalid practice-session profile');
  const profile = encodeURIComponent(profileId);
  const window = windowKind ? `:${encodeURIComponent(windowKind)}` : '';
  return `${SESSION_STORAGE_KEY}/v${SESSION_PROFILE_KEY_VERSION}/${profile}${window}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Whether a snapshot still deserves to be handed back.
 *
 * „Programm starten" means TODAY's FSRS programme. Without a bound, a
 * half-finished programme was resumed forever: every entry point routes to a
 * bare /practice, so the user stayed pinned to a stale item list and new due
 * reviews were never offered again until they ground through it. `savedAt`
 * was being written and never read.
 */
export function isResumable(origin: SessionOrigin, savedAt: string, now: Date): boolean {
  const saved = new Date(savedAt);
  if (Number.isNaN(saved.getTime())) return false;
  if (saved.getTime() > now.getTime() + 60_000) return false; // clock moved back
  const age = now.getTime() - saved.getTime();
  return origin === 'smart'
    ? isSameLocalDay(saved, now) || age < SMART_SESSION_GRACE_MS
    : age < MANUAL_SESSION_MAX_AGE_MS;
}

function createUuid(): string {
  const native = globalThis.crypto?.randomUUID?.();
  if (native) return native.toLowerCase();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeSessionItems(list: readonly SessionItem[], missingIdentitySeed?: string): SessionItem[] {
  const seen = new Set<string>();
  const out: SessionItem[] = [];
  for (const item of list) {
    // A repeated part id cannot be graded twice without corrupting FSRS. Keep
    // the first programme position deterministically.
    if (seen.has(item.partId)) continue;
    seen.add(item.partId);
    const learningInteractionId = item.learningInteractionId ?? (
      missingIdentitySeed
        ? deterministicAiRequestId({
            session: missingIdentitySeed,
            position: out.length,
            questionId: item.questionId,
            partId: item.partId,
          })
        : createUuid()
    );
    out.push(cloneSessionItem({
      ...item,
      learningInteractionId,
      clientAttemptId: item.clientAttemptId ?? deterministicAiRequestId({
        interactionId: learningInteractionId,
        purpose: 'graded-attempt',
      }),
    }));
  }
  return out;
}

const MAX_PENDING_SUBMISSION_BYTES = 64 * 1024;

function shortText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32_768;
}

function isPersistableSubmission(value: unknown): value is Submission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    if (JSON.stringify(value).length > MAX_PENDING_SUBMISSION_BYTES) return false;
  } catch {
    return false;
  }
  const row = value as Record<string, unknown>;
  switch (row.kind) {
    case 'choice':
      return Object.keys(row).every((key) => key === 'kind' || key === 'selected')
        && Array.isArray(row.selected)
        && row.selected.length <= 128
        && row.selected.every((entry) => Number.isInteger(entry) && (entry as number) >= 0);
    case 'matching':
      return Object.keys(row).every((key) => key === 'kind' || key === 'matches')
        && Array.isArray(row.matches)
        && row.matches.length <= 128
        && row.matches.every((entry) => entry === null || (Number.isInteger(entry) && (entry as number) >= 0));
    case 'numeric':
      return Object.keys(row).every((key) => key === 'kind' || key === 'values')
        && !!row.values
        && typeof row.values === 'object'
        && !Array.isArray(row.values)
        && Object.entries(row.values as Record<string, unknown>).length <= 128
        && Object.entries(row.values as Record<string, unknown>).every(([key, entry]) =>
          key.length > 0 && key.length <= 256 && shortText(entry));
    case 'interval':
      return Object.keys(row).every((key) =>
        ['kind', 'lower', 'upper', 'lowerClosed', 'upperClosed'].includes(key))
        && shortText(row.lower)
        && shortText(row.upper)
        && typeof row.lowerClosed === 'boolean'
        && typeof row.upperClosed === 'boolean';
    case 'expression':
      return Object.keys(row).every((key) => key === 'kind' || key === 'expr') && shortText(row.expr);
    case 'open': {
      if (!Object.keys(row).every((key) => key === 'kind' || key === 'text' || key === 'selfAssessment')) return false;
      if (!shortText(row.text) || !row.selfAssessment || typeof row.selfAssessment !== 'object' || Array.isArray(row.selfAssessment)) return false;
      const assessment = row.selfAssessment as Record<string, unknown>;
      return Object.keys(assessment).every((key) => ['criteriaMet', 'overall', 'awardedPoints'].includes(key))
        && (assessment.criteriaMet === undefined
          || (Array.isArray(assessment.criteriaMet)
            && assessment.criteriaMet.length <= 128
            && assessment.criteriaMet.every((entry) => typeof entry === 'boolean')))
        && (assessment.overall === undefined
          || assessment.overall === 'full'
          || assessment.overall === 'partial'
          || assessment.overall === 'none')
        && (assessment.awardedPoints === undefined
          || (typeof assessment.awardedPoints === 'number' && Number.isFinite(assessment.awardedPoints)));
    }
    default:
      return false;
  }
}

function isPersistableSelfAssessment(value: unknown): value is SelfAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => ['criteriaMet', 'overall', 'awardedPoints'].includes(key))
    && (row.criteriaMet === undefined
      || (Array.isArray(row.criteriaMet)
        && row.criteriaMet.length <= 128
        && row.criteriaMet.every((entry) => typeof entry === 'boolean')))
    && (row.overall === undefined
      || row.overall === 'full'
      || row.overall === 'partial'
      || row.overall === 'none')
    && (row.awardedPoints === undefined
      || (typeof row.awardedPoints === 'number' && Number.isFinite(row.awardedPoints)));
}

function isSelfAssessmentDraft(value: unknown): value is SelfAssessmentDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<SelfAssessmentDraft> & Record<string, unknown>;
  return Object.keys(row).every((key) => [
    'version',
    'revision',
    'partId',
    'submission',
    'assessment',
    'selectedPoints',
    'grading',
    'indeterminate',
    'indeterminateMax',
    'savedAt',
  ].includes(key))
    && row.version === 1
    && Number.isSafeInteger(row.revision)
    && (row.revision as number) > 0
    && typeof row.partId === 'string'
    && row.partId.length > 0
    && row.partId.length <= 512
    && isPersistableSubmission(row.submission)
    && isPersistableSelfAssessment(row.assessment)
    && (row.selectedPoints === null
      || (typeof row.selectedPoints === 'number' && Number.isFinite(row.selectedPoints)))
    && (row.grading === null || isGrading(row.grading))
    && typeof row.indeterminate === 'boolean'
    && typeof row.indeterminateMax === 'number'
    && Number.isFinite(row.indeterminateMax)
    && row.indeterminateMax >= 0
    && typeof row.savedAt === 'string'
    && !Number.isNaN(Date.parse(row.savedAt));
}

function isAiExplainCacheLocator(value: unknown): value is AiExplainCacheLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AiExplainCacheLocator> & Record<string, unknown>;
  return Object.keys(row).every((key) => [
    'version',
    'cacheKey',
    'mode',
    'hintLevel',
    'partId',
    'attemptPhase',
    'taskVersion',
    'promptVersion',
    'source',
    'savedAt',
  ].includes(key))
    && row.version === 1
    && typeof row.cacheKey === 'string'
    && /^v2:[0-9a-f]{64}$/u.test(row.cacheKey)
    && (row.mode === 'hint' || row.mode === 'diagnosis')
    && (row.mode === 'hint'
      ? row.hintLevel === 1 || row.hintLevel === 2 || row.hintLevel === 3
      : row.hintLevel === undefined)
    && typeof row.partId === 'string'
    && row.partId.length > 0
    && row.partId.length <= 512
    && (row.attemptPhase === 'first' || row.attemptPhase === 'correction')
    && typeof row.taskVersion === 'string'
    && row.taskVersion.length > 0
    && row.taskVersion.length <= 128
    && typeof row.promptVersion === 'string'
    && row.promptVersion.length > 0
    && row.promptVersion.length <= 128
    && (row.source === 'pool' || row.source === 'byo')
    && typeof row.savedAt === 'string'
    && !Number.isNaN(Date.parse(row.savedAt));
}

function isAiAssessCacheLocator(value: unknown): value is AiAssessCacheLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AiAssessCacheLocator> & Record<string, unknown>;
  return Object.keys(row).every((key) => [
    'version', 'cacheKey', 'requestDigest', 'partId', 'attemptPhase', 'contentSource', 'contentId',
    'taskVersion', 'promptVersion', 'source', 'savedAt',
  ].includes(key))
    && row.version === 1
    && typeof row.cacheKey === 'string'
    && /^v2:[0-9a-f]{64}$/u.test(row.cacheKey)
    && typeof row.requestDigest === 'string'
    && /^v2:[0-9a-f]{64}$/u.test(row.requestDigest)
    && typeof row.partId === 'string'
    && row.partId.length > 0
    && row.partId.length <= 512
    && (row.attemptPhase === 'first' || row.attemptPhase === 'correction')
    && (row.contentSource === 'local' || row.contentSource === 'remote')
    && typeof row.contentId === 'string'
    && /^[0-9a-f]{40}$/u.test(row.contentId)
    && typeof row.taskVersion === 'string'
    && row.taskVersion.length > 0
    && row.taskVersion.length <= 128
    && typeof row.promptVersion === 'string'
    && row.promptVersion.length > 0
    && row.promptVersion.length <= 128
    && (row.source === 'pool' || row.source === 'byo')
    && typeof row.savedAt === 'string'
    && !Number.isNaN(Date.parse(row.savedAt));
}

function newerAiHelp(
  current: AiExplainCacheLocator | undefined,
  pending: AiExplainCacheLocator | undefined,
): AiExplainCacheLocator | undefined {
  if (!current) return pending;
  if (!pending) return current;
  return current.savedAt >= pending.savedAt ? current : pending;
}

/** A late lower hint can never displace content already paid for at a higher level. */
function laterHintLevel(
  current: AiExplainCacheLocator | undefined,
  pending: AiExplainCacheLocator | undefined,
): AiExplainCacheLocator | undefined {
  const currentHint = current?.mode === 'hint' ? current : undefined;
  const pendingHint = pending?.mode === 'hint' ? pending : undefined;
  if (!currentHint) return pendingHint;
  if (!pendingHint) return currentHint;
  if (currentHint.hintLevel !== pendingHint.hintLevel) {
    return (currentHint.hintLevel ?? 0) > (pendingHint.hintLevel ?? 0)
      ? currentHint
      : pendingHint;
  }
  return newerAiHelp(currentHint, pendingHint);
}

function isFsrsState(value: unknown): value is FsrsState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<FsrsState> & Record<string, unknown>;
  return Object.keys(row).every((key) => [
    'due', 'stability', 'difficulty', 'reps', 'lapses', 'lastReview',
  ].includes(key))
    && typeof row.due === 'string'
    && !Number.isNaN(Date.parse(row.due))
    && typeof row.stability === 'number'
    && Number.isFinite(row.stability)
    && typeof row.difficulty === 'number'
    && Number.isFinite(row.difficulty)
    && Number.isSafeInteger(row.reps)
    && (row.reps as number) >= 0
    && Number.isSafeInteger(row.lapses)
    && (row.lapses as number) >= 0
    && (row.lastReview === null
      || (typeof row.lastReview === 'string' && !Number.isNaN(Date.parse(row.lastReview))));
}

function isPendingGrading(value: unknown): value is NonNullable<SessionItem['pendingGrading']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => key === 'grading' || key === 'savedAt')
    && (row.grading === null || isGrading(row.grading))
    && typeof row.savedAt === 'string'
    && !Number.isNaN(Date.parse(row.savedAt));
}

function isAnswerDraft(value: unknown): value is NonNullable<SessionItem['answerDraft']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) => key === 'revision' || key === 'submission' || key === 'savedAt')
    && Number.isSafeInteger(row.revision)
    && (row.revision as number) >= 0
    && (row.submission === undefined || isPersistableSubmission(row.submission))
    && typeof row.savedAt === 'string'
    && !Number.isNaN(Date.parse(row.savedAt));
}

function cloneSubmission(value: Submission): Submission {
  switch (value.kind) {
    case 'choice': return { kind: 'choice', selected: [...value.selected] };
    case 'matching': return { kind: 'matching', matches: [...value.matches] };
    case 'numeric': return { kind: 'numeric', values: { ...value.values } };
    case 'interval': return { ...value };
    case 'expression': return { ...value };
    case 'open': return {
      kind: 'open',
      text: value.text,
      selfAssessment: {
        ...value.selfAssessment,
        ...(value.selfAssessment.criteriaMet
          ? { criteriaMet: [...value.selfAssessment.criteriaMet] }
          : {}),
      },
    };
  }
}

function cloneSessionItem(item: SessionItem): SessionItem {
  return {
    ...item,
    ...(item.answerDraft
      ? {
          answerDraft: {
            revision: item.answerDraft.revision,
            ...(item.answerDraft.submission
              ? { submission: cloneSubmission(item.answerDraft.submission) }
              : {}),
            savedAt: item.answerDraft.savedAt,
          },
        }
      : {}),
  };
}

function cloneSelfAssessmentDraft(value: SelfAssessmentDraft): SelfAssessmentDraft {
  return {
    ...value,
    submission: cloneSubmission(value.submission),
    assessment: {
      ...value.assessment,
      ...(value.assessment.criteriaMet
        ? { criteriaMet: [...value.assessment.criteriaMet] }
        : {}),
    },
  };
}

/** A protocol/revision violation must never degrade to a stale-cache session. */
class ContentIntegrityError extends Error {
  override readonly name = 'ContentIntegrityError';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function assetKey(src: string): string {
  return src.replace(/^\/+/, '').replace(/^assets\//, '');
}

/** Collect only paths that the UI resolves as bank assets. */
function questionAssetPaths(question: Question): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (
      typeof node.src === 'string'
      && (node.t === 'fig' || node.kind === 'image')
    ) paths.add(assetKey(node.src));
    for (const nested of Object.values(node)) visit(nested);
  };
  visit(question);
  return [...paths];
}

function assertQuestionMatchesManifest(
  manifest: ManifestResponse,
  question: Question,
  advertisedWireHash?: string,
): void {
  if (manifest.formatVersion !== 2) return;
  const record = manifest.questions[question.id];
  if (!record) {
    throw new ContentIntegrityError(
      t('Aufgabe {id} fehlt im überprüften Aufgabenbank-Manifest.', { id: question.id }),
    );
  }
  const actualWireHash = questionContentHash(question);
  if (
    actualWireHash !== record.wireSha256
    || (advertisedWireHash !== undefined && advertisedWireHash !== record.wireSha256)
  ) {
    throw new ContentIntegrityError(
      t('Die Übertragungs-Prüfsumme von Aufgabe {id} stimmt nicht mit der Aufgabenbank überein.', { id: question.id }),
    );
  }
  const actualAssets = questionAssetPaths(question);
  const expectedAssets = new Set(record.assets);
  if (
    actualAssets.length !== record.assets.length
    || actualAssets.some((path) => !expectedAssets.has(path))
  ) {
    throw new ContentIntegrityError(
      t('Die Grafiken von Aufgabe {id} stimmen nicht mit der Aufgabenbank überein.', { id: question.id }),
    );
  }
}

async function readBoundedAsset(
  response: Response,
  remainingBytes: number,
  expected?: ManifestAssetV2,
): Promise<Blob> {
  if (!response.ok) {
    throw new ContentIntegrityError(t('Eine Aufgabengrafik konnte nicht geladen werden ({status}).', { status: response.status }));
  }
  const allowed = Math.min(MAX_SINGLE_ASSET_BYTES, remainingBytes);
  const declaredHeader = response.headers.get('content-length');
  if (!declaredHeader || !/^(?:0|[1-9][0-9]*)$/u.test(declaredHeader)) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat keine gültige Längenangabe geliefert.');
  }
  const declared = Number(declaredHeader);
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat keine gültige Längenangabe geliefert.');
  }
  if (declared > allowed) {
    throw new ContentIntegrityError('Eine Aufgabengrafik überschreitet das sichere Größenlimit.');
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'image/png' || (expected && contentType !== expected.mimeType)) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat einen unerwarteten Dateityp geliefert.');
  }
  if (expected && declared !== expected.bytes) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat eine unerwartete Größe geliefert.');
  }
  const etag = response.headers.get('etag');
  const etagMatch = /^"([0-9a-f]{64})"$/u.exec(etag ?? '');
  // The validated v2 manifest already authenticates this exact revision's
  // bytes independently of transport headers. A proxy may hide or weaken an
  // ETag without changing the PNG; that must not discard a stronger proof.
  // Legacy revision manifests contain no asset hashes and still require a
  // strong ETag. Neither path ever admits bytes without a SHA-256 match.
  const expectedHash = expected?.sha256 ?? etagMatch?.[1];
  if (!expectedHash) {
    throw new ContentIntegrityError('Eine Aufgabengrafik hat keine starke Prüfsumme geliefert.');
  }
  if (expected && etagMatch && etagMatch[1] !== expected.sha256) {
    throw new ContentIntegrityError('Die angekündigte Prüfsumme einer Aufgabengrafik ist ungültig.');
  }

  let bytes: Uint8Array;
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > allowed) {
      throw new ContentIntegrityError('Eine Aufgabengrafik überschreitet das sichere Größenlimit.');
    }
    if (blob.size !== declared) {
      throw new ContentIntegrityError('Eine Aufgabengrafik wurde unvollständig übertragen.');
    }
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else {
    const reader = response.body.getReader();
    bytes = new Uint8Array(declared);
    let received = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const nextReceived = received + next.value.byteLength;
        if (nextReceived > allowed) {
          await reader.cancel();
          throw new ContentIntegrityError('Eine Aufgabengrafik überschreitet das sichere Größenlimit.');
        }
        if (nextReceived > declared) {
          await reader.cancel();
          throw new ContentIntegrityError('Eine Aufgabengrafik hat eine falsche Längenangabe geliefert.');
        }
        bytes.set(next.value, received);
        received = nextReceived;
      }
    } finally {
      reader.releaseLock();
    }
    if (received !== declared) {
      throw new ContentIntegrityError('Eine Aufgabengrafik wurde unvollständig übertragen.');
    }
  }

  const verifiedBytes = new Uint8Array(bytes.byteLength);
  verifiedBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', verifiedBytes.buffer);
  const actualHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (actualHash !== expectedHash) {
    throw new ContentIntegrityError('Die Prüfsumme einer Aufgabengrafik ist ungültig.');
  }
  return new Blob([verifiedBytes.buffer], { type: 'image/png' });
}

/** Retry only interrupted transport; a contradictory content proof is final. */
async function fetchVerifiedAsset(
  url: string,
  remainingBytes: number,
  expected?: ManifestAssetV2,
): Promise<Blob> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const deadline = globalThis.setTimeout(() => controller.abort(), ASSET_REQUEST_TIMEOUT_MS);
    let retryDelayMs = ASSET_RETRY_DELAY_MS;
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok && RETRYABLE_ASSET_STATUSES.has(response.status) && attempt === 0) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const seconds = /^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) : undefined;
          const waitMs = seconds !== undefined ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
          // Never hammer a throttled Core, or hold the loading screen for an
          // unbounded Retry-After. A later explicit retry remains available.
          if (!Number.isFinite(waitMs) || waitMs > MAX_ASSET_RETRY_DELAY_MS) {
            throw new ContentIntegrityError(t('Eine Aufgabengrafik konnte nicht geladen werden ({status}).', { status: response.status }));
          }
          retryDelayMs = Math.max(retryDelayMs, waitMs);
        }
        throw new Error(`Temporary figure response: ${response.status}`);
      }
      return await readBoundedAsset(response, remainingBytes, expected);
    } catch (cause) {
      if (cause instanceof ContentIntegrityError) throw cause;
      if (attempt > 0 || globalThis.navigator?.onLine === false) {
        throw new Error(t('Grafik konnte nicht geladen werden. Bitte erneut versuchen.'), { cause });
      }
    } finally {
      globalThis.clearTimeout(deadline);
      // Also cancel a rejected/unused response body rather than leaving it
      // downloading after a metadata failure or before the bounded retry.
      controller.abort();
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, retryDelayMs));
  }
  throw new Error(t('Grafik konnte nicht geladen werden. Bitte erneut versuchen.'));
}

export const usePracticeStore = defineStore('practice', () => {
  const items = ref<SessionItem[]>([]);
  const questions = shallowRef<Map<string, Question>>(new Map());
  const index = ref(0);
  const origin = ref<SessionOrigin>('smart');
  const graded = ref<GradedRecord[]>([]);
  const selfAssessmentDraft = ref<SelfAssessmentDraft | undefined>();
  const draftRevision = ref(0);
  const phase = ref<
    'idle' | 'loading' | 'provenance-choice' | 'running' | 'summary' | 'error'
  >('idle');
  const error = ref<string | undefined>();
  /** Non-fatal notice (e.g. some questions failed to load, session continues). */
  const warning = ref<string | undefined>();
  /** Paid AI is gated until the current items and their identities are durable. */
  const sessionIdentityDurable = ref(false);
  /** Content provenance is fixed for the lifetime of this renderer's session. */
  const contentSource = ref<CoreSourcePreference>('remote');
  const contentId = ref<string | undefined>();
  const contentMode = ref<'current' | 'revision'>('current');
  const partShownAt = ref(0);
  /**
   * Last time the live session was written — the in-memory counterpart of the
   * snapshot's `savedAt`. Judging a running session by its START time instead
   * declared an actively used session stale and deleted a still-fresh
   * snapshot underneath it.
   */
  const lastActivityAt = ref(new Date().toISOString());
  /** Last thing the user asked for, so the error screen can retry THAT. */
  const lastRequest = ref<
    {
      kind: 'smart';
      source: CoreSourcePreference;
      opts?: { count?: number; filters?: QuestionsFilter };
      contentId?: string;
    }
    | { kind: 'questions'; source: CoreSourcePreference; ids: string[]; contentId?: string }
    | undefined
  >();
  /** Pre-answer FSRS snapshots for same-event manual override (per partId). */
  const preAnswerFsrs = new Map<string, FsrsState | undefined>();
  /** Exact first-attempt identity retained across a recoverable commit error. */
  const pendingGradeRecords = new Map<string, { record: GradedRecord; manualGrading?: Grading }>();
  /** Serialize session writes so a slower, older snapshot cannot win. */
  let sessionPersistenceTail: Promise<void> = Promise.resolve();
  /** One durable write plus one coalesced latest intent per session part. */
  const answerDraftWritePipelines = new Map<string, AnswerDraftWritePipeline>();
  /** Fixed for the whole live session; auth changes cannot retarget it. */
  let sessionOwner: AttemptOwnerSnapshot | undefined;
  let sessionStorageKey: string | undefined;
  let sessionResolvedOwnerId: string | undefined;
  let sessionCoreClient: CoreClient | undefined;
  let sessionManifest: ManifestResponse | undefined;
  let sessionManifestUnavailable = false;
  let sessionLearningRecommendations = false;
  let pinnedAssetUrls = new Map<string, string>();
  // Content loaders mutate one session and one set of verified object URLs.
  // Keep the complete load/admit/save transaction ordered, not merely its I/O.
  let contentLoadTail: Promise<void> = Promise.resolve();
  let contentLoadEpoch = 0;
  let activeContentLoad: { epoch: number; profileId: LocalProfileId | undefined; signal?: AbortSignal } | undefined;
  let pendingExactRestore: { snapshot: PersistedPracticeSession; source: CoreSourcePreference; contentId: string } | undefined;

  function assertContentLoadCurrent(): void {
    const load = activeContentLoad;
    if (load && (load.epoch !== contentLoadEpoch || load.signal?.aborted
      || (load.profileId !== undefined && load.profileId !== localProfileStore.currentIfInitialized()))) {
      throw new DOMException('The practice load was cancelled or its account changed.', 'AbortError');
    }
  }

  function runContentLoad<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const epoch = contentLoadEpoch;
    const profileId = localProfileStore.currentIfInitialized();
    const run = contentLoadTail.then(async () => {
      activeContentLoad = { epoch, profileId, signal };
      let started = false;
      try {
        assertContentLoadCurrent();
        started = true;
        return await task();
      } catch (cause) {
        if (started && epoch === contentLoadEpoch
          && cause instanceof DOMException && cause.name === 'AbortError'
          && (phase.value === 'loading' || !sessionIdentityDurable.value)) {
          // Cancellation is not `abort()`: the previously durable programme
          // stays on disk. Drop only this unfinished load's in-memory material.
          questions.value = new Map();
          revokePinnedAssets();
          phase.value = 'idle';
          sessionIdentityDurable.value = false;
        }
        throw cause;
      } finally {
        if (started && (epoch !== contentLoadEpoch || signal?.aborted
          || (profileId !== undefined && profileId !== localProfileStore.currentIfInitialized()))) {
          useAppStore().releaseCoreContentPin();
        }
        activeContentLoad = undefined;
      }
    });
    contentLoadTail = run.then(() => undefined, () => undefined);
    return run;
  }
  /**
   * Kept verbatim while an old snapshot waits for explicit consent. A failed
   * current-bank load keeps it too, so retry never turns into a fresh session.
   */
  let pendingUnprovenancedSession:
    | { snapshot: PersistedPracticeSession; selectedSource?: CoreSourcePreference }
    | undefined;

  function revokePinnedAssets(): void {
    for (const url of pinnedAssetUrls.values()) URL.revokeObjectURL(url);
    pinnedAssetUrls = new Map();
  }

  function enterFailClosedError(cause: unknown): void {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    questions.value = new Map();
    revokePinnedAssets();
    phase.value = 'error';
    error.value = cause instanceof Error ? cause.message : String(cause);
  }

  function commitPinnedAssets(blobs: Map<string, Blob>): void {
    const next = new Map<string, string>();
    try {
      for (const [path, blob] of blobs) next.set(path, URL.createObjectURL(blob));
    } catch (cause) {
      for (const url of next.values()) URL.revokeObjectURL(url);
      throw new ContentIntegrityError('Die lokalen Aufgabengrafiken konnten nicht vorbereitet werden.', { cause });
    }
    revokePinnedAssets();
    pinnedAssetUrls = next;
  }

  async function prepareAssetSnapshot(
    client: CoreClient,
    questionMap: Map<string, Question>,
    revision: string,
    manifest: ManifestResponse,
    mode: 'current' | 'revision',
  ): Promise<Map<string, Blob>> {
    const paths = new Set<string>();
    for (const question of questionMap.values()) {
      for (const path of questionAssetPaths(question)) paths.add(path);
    }
    const blobs = new Map<string, Blob>();
    let total = 0;
    for (const path of paths) {
      assertContentLoadCurrent();
      const expected = manifest.formatVersion === 2 ? manifest.assets[path] : undefined;
      if (manifest.formatVersion === 2 && !expected) {
        throw new ContentIntegrityError(
          t('Aufgabengrafik {path} fehlt im überprüften Aufgabenbank-Manifest.', { path }),
        );
      }
      const url = mode === 'current' && manifest.formatVersion === 2
        ? client.assetUrl(path, revision)
        : client.revisionAssetUrl(path, revision);
      const blob = await fetchVerifiedAsset(
        url,
        MAX_PINNED_ASSET_BYTES - total,
        expected,
      );
      assertContentLoadCurrent();
      total += blob.size;
      blobs.set(path, blob);
    }
    return blobs;
  }

  interface SessionProfileCandidate {
    profileId: LocalProfileId;
    claimed: boolean;
  }

  interface LocatedPracticeSession {
    snapshot: PersistedPracticeSession;
    key: string;
    profileId: LocalProfileId;
    resolvedOwnerId: string;
  }

  function currentWindowKind(): string | undefined {
    return ports.shell.capabilities.desktop ? ports.shell.windowKind : undefined;
  }

  function storageKeyForProfile(profileId: LocalProfileId): string {
    return practiceSessionStorageKey(profileId, currentWindowKind());
  }

  function requiredOwnerProfile(owner: AttemptOwnerSnapshot): LocalProfileId {
    if (!isLocalProfileId(owner.localProfileId)) {
      throw new Error('Practice session has no local profile identity');
    }
    return owner.localProfileId;
  }

  function legacyStorageKeysForOwner(owner: AttemptOwnerSnapshot): string[] {
    const keyOwner = owner.userId === GUEST_ATTEMPT_OWNER ? 'guest' : owner.userId;
    const base = `${SESSION_STORAGE_KEY}:${keyOwner}`;
    const windowKind = currentWindowKind();
    return windowKind ? [`${base}:${windowKind}`, base] : [base];
  }

  function sameCapturedOwner(
    persisted: AttemptOwnerSnapshot,
    requested: AttemptOwnerSnapshot,
  ): boolean {
    if (persisted.userId !== requested.userId) return false;
    return persisted.userId !== GUEST_ATTEMPT_OWNER
      || persisted.guestGeneration === requested.guestGeneration;
  }

  function upgradeSessionForProfile(
    value: unknown,
    requestedOwner: AttemptOwnerSnapshot,
    candidate: SessionProfileCandidate,
    claimedGuestGeneration?: string,
  ): PersistedPracticeSession | undefined {
    if (!isPersistedPracticeSession(value)) return undefined;
    if (value.version === SESSION_STORAGE_VERSION) {
      const owner = value.owner!;
      if (owner.localProfileId !== candidate.profileId) return undefined;
      if (candidate.claimed) {
        const ownedByClaimedGuest = owner.userId === GUEST_ATTEMPT_OWNER
          && !!claimedGuestGeneration
          && owner.guestGeneration === claimedGuestGeneration;
        const ownedByDestination = owner.userId === requestedOwner.userId;
        if (!ownedByClaimedGuest && !ownedByDestination) {
          return undefined;
        }
      } else if (!sameCapturedOwner(owner, requestedOwner)) {
        return undefined;
      }
      return value;
    }

    let owner: AttemptOwnerSnapshot;
    if (value.version === 2) {
      // A generic v2 guest key has no generation and can therefore not be
      // attributed after multiple guest rotations. Keep it untouched rather
      // than risk handing one person's programme to another account.
      if (candidate.claimed) return undefined;
      owner = { ...requestedOwner, localProfileId: candidate.profileId };
    } else {
      const legacyOwner = value.owner!;
      if (candidate.claimed) {
        if (
          legacyOwner.userId !== GUEST_ATTEMPT_OWNER
          || !claimedGuestGeneration
          || legacyOwner.guestGeneration !== claimedGuestGeneration
        ) {
          return undefined;
        }
      } else if (!sameCapturedOwner(legacyOwner, requestedOwner)) {
        return undefined;
      }
      owner = { ...legacyOwner, localProfileId: candidate.profileId };
    }
    return {
      ...value,
      version: SESSION_STORAGE_VERSION,
      owner,
    };
  }

  async function upgradeSessionAtKey(
    key: string,
    requestedOwner: AttemptOwnerSnapshot,
    candidate: SessionProfileCandidate,
    claimedGuestGeneration?: string,
  ): Promise<PersistedPracticeSession | undefined> {
    if (!hasAtomicStorage(storage)) {
      const upgrade = async (): Promise<PersistedPracticeSession | undefined> => {
        const raw = await storage.get<unknown>(STORAGE.app, key);
        const snapshot = upgradeSessionForProfile(
          raw,
          requestedOwner,
          candidate,
          claimedGuestGeneration,
        );
        if (!snapshot) return undefined;
        if (
          (raw as { version?: unknown } | undefined)?.version !== SESSION_STORAGE_VERSION
        ) {
          await storage.set(STORAGE.app, key, snapshot);
        }
        return snapshot;
      };
      return storage.runExclusiveMutation ? storage.runExclusiveMutation(upgrade) : upgrade();
    }
    const address = { collection: STORAGE.app, key } as const;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [entry] = await storage.readBatch([address]);
      if (!entry?.exists) return undefined;
      const snapshot = upgradeSessionForProfile(
        entry.value,
        requestedOwner,
        candidate,
        claimedGuestGeneration,
      );
      if (!snapshot) return undefined;
      if (
        (entry.value as { version?: unknown }).version === SESSION_STORAGE_VERSION
      ) {
        return snapshot;
      }
      try {
        const committed = await storage.commitBatch({
          ifRevisions: [{ ...address, revision: entry.revision }],
          mutations: [{ ...address, operation: 'set', value: snapshot }],
        });
        if (committed.committed) return snapshot;
      } catch (cause) {
        const durable = await storage.get<unknown>(STORAGE.app, key).catch(() => undefined);
        const confirmed = upgradeSessionForProfile(
          durable,
          requestedOwner,
          candidate,
          claimedGuestGeneration,
        );
        if (confirmed?.version === SESSION_STORAGE_VERSION) return confirmed;
        throw cause;
      }
    }
    throw new Error('Practice session changed too often to upgrade safely');
  }

  /**
   * Move one validated pre-2.2 key into its profile scope. The source is
   * deleted in the same CAS as the destination write; an occupied destination
   * is never overwritten and an unowned/malformed source is never deleted.
   */
  async function migrateLegacySession(
    sourceKey: string,
    destinationKey: string,
    requestedOwner: AttemptOwnerSnapshot,
    candidate: SessionProfileCandidate,
    claimedGuestGeneration?: string,
  ): Promise<PersistedPracticeSession | undefined> {
    const legacyGuestKey = `${SESSION_STORAGE_KEY}:guest`;
    const ownerlessGuestBecameAmbiguous = (raw: unknown): boolean =>
      (sourceKey === legacyGuestKey || sourceKey.startsWith(`${legacyGuestKey}:`))
      && isPersistedPracticeSession(raw)
      && raw.version === 2
      && localProfileStore.snapshot().routes.length > 0;
    if (!hasAtomicStorage(storage)) {
      const migrate = async (): Promise<PersistedPracticeSession | undefined> => {
        if (await storage.get<unknown>(STORAGE.app, destinationKey) !== undefined) return undefined;
        const raw = await storage.get<unknown>(STORAGE.app, sourceKey);
        if (ownerlessGuestBecameAmbiguous(raw)) return undefined;
        const snapshot = upgradeSessionForProfile(
          raw,
          requestedOwner,
          candidate,
          claimedGuestGeneration,
        );
        if (!snapshot) return undefined;
        await storage.set(STORAGE.app, destinationKey, snapshot);
        await storage.delete(STORAGE.app, sourceKey);
        return snapshot;
      };
      return storage.runExclusiveMutation ? storage.runExclusiveMutation(migrate) : migrate();
    }
    const source = { collection: STORAGE.app, key: sourceKey } as const;
    const destination = { collection: STORAGE.app, key: destinationKey } as const;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [sourceEntry, destinationEntry] = await storage.readBatch([source, destination]);
      if (!sourceEntry || !destinationEntry || !sourceEntry.exists || destinationEntry.exists) {
        return undefined;
      }
      if (ownerlessGuestBecameAmbiguous(sourceEntry.value)) return undefined;
      const snapshot = upgradeSessionForProfile(
        sourceEntry.value,
        requestedOwner,
        candidate,
        claimedGuestGeneration,
      );
      if (!snapshot) return undefined;
      try {
        const committed = await storage.commitBatch({
          ifRevisions: [
            { ...source, revision: sourceEntry.revision },
            { ...destination, revision: destinationEntry.revision },
          ],
          mutations: [
            { ...destination, operation: 'set', value: snapshot },
            { ...source, operation: 'delete' },
          ],
        });
        if (committed.committed) return snapshot;
      } catch (cause) {
        const durable = await storage.get<unknown>(STORAGE.app, destinationKey).catch(() => undefined);
        const confirmed = upgradeSessionForProfile(
          durable,
          requestedOwner,
          candidate,
          claimedGuestGeneration,
        );
        if (confirmed?.version === SESSION_STORAGE_VERSION) return confirmed;
        throw cause;
      }
    }
    throw new Error('Legacy practice session changed too often to migrate safely');
  }

  async function locatePersistedSession(
    requestedOwner: AttemptOwnerSnapshot,
  ): Promise<LocatedPracticeSession | undefined> {
    const requestedProfile = requiredOwnerProfile(requestedOwner);
    const profiles = localProfileStore.readableProfiles(requestedProfile);
    const candidates: SessionProfileCandidate[] = profiles.map((profileId) => ({
      profileId,
      claimed: profileId !== requestedProfile,
    }));
    const claimedRoute = requestedOwner.userId === GUEST_ATTEMPT_OWNER
      ? undefined
      : await attemptOutbox.guestClaimRouteForUser(requestedOwner.userId);

    // Profile-scoped snapshots always win over pre-2.2 compatibility keys.
    for (const candidate of candidates) {
      const key = storageKeyForProfile(candidate.profileId);
      const snapshot = await upgradeSessionAtKey(
        key,
        requestedOwner,
        candidate,
        candidate.claimed ? claimedRoute?.sourceGeneration : undefined,
      );
      if (snapshot) {
        return {
          snapshot,
          key,
          profileId: candidate.profileId,
          resolvedOwnerId: candidate.claimed ? requestedOwner.userId : snapshot.owner!.userId,
        };
      }
    }

    const visitedLegacyKeys = new Set<string>();
    for (const candidate of candidates) {
      const legacyOwner: AttemptOwnerSnapshot = candidate.claimed
        ? { userId: GUEST_ATTEMPT_OWNER, guestGeneration: claimedRoute?.sourceGeneration }
        : requestedOwner;
      for (const legacyKey of legacyStorageKeysForOwner(legacyOwner)) {
        if (visitedLegacyKeys.has(legacyKey)) continue;
        visitedLegacyKeys.add(legacyKey);
        const key = storageKeyForProfile(candidate.profileId);
        const snapshot = await migrateLegacySession(
          legacyKey,
          key,
          requestedOwner,
          candidate,
          candidate.claimed ? claimedRoute?.sourceGeneration : undefined,
        );
        if (snapshot) {
          return {
            snapshot,
            key,
            profileId: candidate.profileId,
            resolvedOwnerId: candidate.claimed ? requestedOwner.userId : snapshot.owner!.userId,
          };
        }
      }
    }
    return undefined;
  }

  function setSessionIdentity(
    owner: AttemptOwnerSnapshot,
    options: { key?: string; resolvedOwnerId?: string } = {},
  ): AttemptOwnerSnapshot {
    const profileId = requiredOwnerProfile(owner);
    sessionOwner = { ...owner, localProfileId: profileId };
    sessionStorageKey = options.key ?? storageKeyForProfile(profileId);
    sessionResolvedOwnerId = options.resolvedOwnerId ?? owner.userId;
    return sessionOwner;
  }

  function profileCanAccessSession(profileId: LocalProfileId): boolean {
    const ownerProfile = sessionOwner?.localProfileId;
    return isLocalProfileId(ownerProfile)
      && localProfileStore.readableProfiles(profileId).includes(ownerProfile);
  }

  function activeProfileCanAccessSession(): boolean {
    const activeProfile = localProfileStore.currentIfInitialized();
    return !!activeProfile && profileCanAccessSession(activeProfile);
  }

  async function ensureSessionIdentity(): Promise<AttemptOwnerSnapshot> {
    if (sessionOwner) return sessionOwner;
    return setSessionIdentity(await useProgressStore().captureAttemptOwner());
  }

  async function bindSessionContent(
    requestedSource?: CoreSourcePreference,
    expectedContentId?: string,
    preserveVerifiedAssets = false,
  ): Promise<CoreClient> {
    const app = useAppStore();
    const pin = await app.pinCoreContent(
      requestedSource ?? app.coreEndpointSource,
      expectedContentId,
    );
    assertContentLoadCurrent();
    if (expectedContentId && pin.contentId && pin.contentId !== expectedContentId) {
      throw new Error(
        'Die Aufgabenbank dieses Programms wurde geändert. Der lokale Stand bleibt erhalten; bitte starte das Programm mit der passenden Quelle neu.',
      );
    }
    const keepAssets = preserveVerifiedAssets && contentId.value !== undefined
      && contentSource.value === pin.source
      && contentId.value === (pin.contentId ?? expectedContentId);
    contentSource.value = pin.source;
    contentId.value = pin.contentId ?? expectedContentId;
    sessionCoreClient = pin.client;
    contentMode.value = pin.mode;
    sessionManifest = pin.manifest;
    sessionManifestUnavailable = pin.manifestUnavailable === true;
    sessionLearningRecommendations = pin.learningRecommendations;
    if (!keepAssets) revokePinnedAssets();
    const request = lastRequest.value;
    if (contentId.value && request) {
      lastRequest.value = { ...request, contentId: contentId.value };
    }
    return pin.client;
  }

  function enqueueSessionPersistence<Result>(task: () => Promise<Result>): Promise<Result> {
    const run = sessionPersistenceTail.then(task, task);
    sessionPersistenceTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function cloneGradedRecord(record: GradedRecord): GradedRecord {
    const breakdown = record.result.breakdown?.map((item) => ({ ...item }));
    return {
      ...record,
      result: {
        ...record.result,
        ...(breakdown ? { breakdown } : {}),
      },
      ...(record.pendingSubmission
        ? { pendingSubmission: cloneSubmission(record.pendingSubmission) }
        : {}),
      ...(record.correctionDraft
        ? {
            correctionDraft: {
              submission: cloneSubmission(record.correctionDraft.submission),
              savedAt: record.correctionDraft.savedAt,
            },
          }
        : {}),
      ...(record.preAnswerFsrs ? { preAnswerFsrs: { ...record.preAnswerFsrs } } : {}),
    };
  }

  function buildPersistedSession(
    owner: AttemptOwnerSnapshot,
    records: readonly GradedRecord[],
    savedAt: string,
    draftState: { revision: number; draft?: SelfAssessmentDraft } = {
      revision: draftRevision.value,
      ...(selfAssessmentDraft.value ? { draft: selfAssessmentDraft.value } : {}),
    },
  ): PersistedPracticeSession {
    return {
      version: SESSION_STORAGE_VERSION,
      owner: { ...owner },
      contentSource: contentSource.value,
      ...(contentId.value ? { contentId: contentId.value } : {}),
      origin: origin.value,
      items: items.value.map(cloneSessionItem),
      index: index.value,
      graded: records.map(cloneGradedRecord),
      draftRevision: draftState.revision,
      ...(draftState.draft ? { selfAssessmentDraft: cloneSelfAssessmentDraft(draftState.draft) } : {}),
      savedAt,
    };
  }

  function mergeSessionDraft(
    current: PersistedPracticeSession,
    pending: PersistedPracticeSession,
  ): Pick<PersistedPracticeSession, 'draftRevision' | 'selfAssessmentDraft'> {
    const currentRevision = current.draftRevision ?? 0;
    const pendingRevision = pending.draftRevision ?? 0;
    if (pendingRevision < currentRevision) {
      return {
        draftRevision: currentRevision,
        ...(current.selfAssessmentDraft
          ? { selfAssessmentDraft: cloneSelfAssessmentDraft(current.selfAssessmentDraft) }
          : {}),
      };
    }
    if (pendingRevision === currentRevision) {
      if (JSON.stringify(current.selfAssessmentDraft) !== JSON.stringify(pending.selfAssessmentDraft)) {
        throw new Error('A self-assessment draft changed in another window');
      }
      return {
        draftRevision: currentRevision,
        ...(current.selfAssessmentDraft
          ? { selfAssessmentDraft: cloneSelfAssessmentDraft(current.selfAssessmentDraft) }
          : {}),
      };
    }
    if (pendingRevision !== currentRevision + 1) {
      throw new Error('Self-assessment draft revision is not contiguous');
    }
    return {
      draftRevision: pendingRevision,
      ...(pending.selfAssessmentDraft
        ? { selfAssessmentDraft: cloneSelfAssessmentDraft(pending.selfAssessmentDraft) }
        : {}),
    };
  }

  function mergeAnswerDraft(
    current: SessionItem['answerDraft'],
    pending: SessionItem['answerDraft'],
    graded: boolean,
    fallbackSavedAt: string,
  ): SessionItem['answerDraft'] {
    if (!current && !pending) return undefined;
    const currentRevision = current?.revision ?? 0;
    const pendingRevision = pending?.revision ?? 0;
    const latestSavedAt = [current?.savedAt, pending?.savedAt, fallbackSavedAt]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1)!;
    if (graded) {
      return {
        revision: Math.max(currentRevision, pendingRevision),
        savedAt: latestSavedAt,
      };
    }
    const winner = currentRevision > pendingRevision
      ? current
      : pendingRevision > currentRevision
        ? pending
        : undefined;
    if (winner) {
      return {
        revision: winner.revision,
        ...(winner.submission ? { submission: cloneSubmission(winner.submission) } : {}),
        savedAt: winner.savedAt,
      };
    }
    if (JSON.stringify(current) !== JSON.stringify(pending)) {
      throw new Error('An answer draft changed in another window');
    }
    return current
      ? {
          revision: current.revision,
          ...(current.submission ? { submission: cloneSubmission(current.submission) } : {}),
          savedAt: current.savedAt,
        }
      : undefined;
  }

  function sameSessionDefinition(
    current: PersistedPracticeSession,
    expected: PersistedPracticeSession,
  ): boolean {
    return current.version === SESSION_STORAGE_VERSION
      && current.origin === expected.origin
      && current.contentSource === expected.contentSource
      && current.contentId === expected.contentId
      && current.items.length === expected.items.length
      && current.items.every((item, itemIndex) => {
        const other = expected.items[itemIndex];
        return other !== undefined
          && item.questionId === other.questionId
          && item.partId === other.partId
          && item.reason === other.reason
          && (
            !item.learningInteractionId
            || !other.learningInteractionId
            || item.learningInteractionId === other.learningInteractionId
          )
          && (
            !item.clientAttemptId
            || !other.clientAttemptId
            || item.clientAttemptId === other.clientAttemptId
          );
      });
  }

  function mergeSessionGradeRecords(
    current: readonly GradedRecord[],
    pending: readonly GradedRecord[],
  ): GradedRecord[] {
    const merged = current.map(cloneGradedRecord);
    const indices = new Map(merged.map((record, index) => [record.clientAttemptId, index]));
    for (const record of pending) {
      const index = indices.get(record.clientAttemptId);
      if (index === undefined) {
        indices.set(record.clientAttemptId, merged.length);
        merged.push(cloneGradedRecord(record));
        continue;
      }
      let current = merged[index]!;
      if (!current.correctionOutcome && !current.correctionClosedAt) {
        const currentDraft = current.correctionDraft;
        const pendingDraft = record.correctionDraft;
        const durableDraft = !currentDraft
          ? pendingDraft
          : !pendingDraft || currentDraft.savedAt >= pendingDraft.savedAt
            ? currentDraft
            : pendingDraft;
        if (durableDraft) {
          merged[index] = cloneGradedRecord({ ...current, correctionDraft: durableDraft });
          current = merged[index]!;
        }
      }
      if (current.correctionOutcome && record.correctionOutcome
        && current.correctionOutcome !== record.correctionOutcome) {
        throw new Error('Concurrent correction outcome conflicts with the durable session');
      }
      if (current.correctionClosedAt && record.correctionOutcome) {
        throw new Error('A closed correction cannot be replaced by a stale correction');
      }
      if (!current.correctionOutcome && !current.correctionClosedAt && record.correctionOutcome) {
        const {
          pendingSubmission: _privateAnswer,
          correctionDraft: _correctionDraft,
          ...withoutPrivateAnswer
        } = current;
        merged[index] = cloneGradedRecord({
          ...withoutPrivateAnswer,
          correctionOutcome: record.correctionOutcome,
          ...(record.correctedAt ? { correctedAt: record.correctedAt } : {}),
        });
      } else if (!current.correctionOutcome && !current.correctionClosedAt && record.correctionClosedAt) {
        const {
          pendingSubmission: _privateAnswer,
          correctionDraft: _correctionDraft,
          ...withoutPrivateAnswer
        } = current;
        merged[index] = cloneGradedRecord({
          ...withoutPrivateAnswer,
          correctionClosedAt: record.correctionClosedAt,
        });
      }
    }
    return merged;
  }

  async function commitSessionSnapshot(
    key: string,
    snapshot: PersistedPracticeSession,
    replaceExisting: boolean,
  ): Promise<PersistedPracticeSession> {
    if (!hasAtomicStorage(storage)) {
      assertContentLoadCurrent();
      await storage.set(STORAGE.app, key, snapshot);
      return snapshot;
    }
    const address = { collection: STORAGE.app, key } as const;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [entry] = await storage.readBatch([address]);
      if (!entry) throw new Error('Practice session revision read returned no entry');
      let next = snapshot;
      if (entry.value !== undefined) {
        if (!isPersistedPracticeSession(entry.value)) {
          throw new Error('Stored practice session is malformed');
        }
        const current = entry.value;
        if (sameSessionDefinition(current, snapshot) && !replaceExisting) {
          const { selfAssessmentDraft: _pendingDraft, ...snapshotWithoutDraft } = snapshot;
          const mergedGraded = mergeSessionGradeRecords(current.graded, snapshot.graded);
          const gradedPartIds = new Set(mergedGraded.map((record) => record.partId));
          next = {
            ...snapshotWithoutDraft,
            items: snapshot.items.map((item, itemIndex): SessionItem => {
              const deliveredHintLevel = Math.max(
                item.deliveredHintLevel ?? 0,
                current.items[itemIndex]?.deliveredHintLevel ?? 0,
              ) as 0 | LearningHintLevel;
              const currentItem = current.items[itemIndex];
              const cachedAiHint = laterHintLevel(
                currentItem?.cachedAiHint ?? currentItem?.cachedAiHelp,
                item.cachedAiHint ?? item.cachedAiHelp,
              );
              const cachedAiDiagnosis = newerAiHelp(
                currentItem?.cachedAiDiagnosis
                  ?? (currentItem?.cachedAiHelp?.mode === 'diagnosis'
                    ? currentItem.cachedAiHelp
                    : undefined),
                item.cachedAiDiagnosis
                  ?? (item.cachedAiHelp?.mode === 'diagnosis' ? item.cachedAiHelp : undefined),
              );
              const currentAssessment = current.items[itemIndex]?.cachedAiAssessment;
              const pendingAssessment = item.cachedAiAssessment;
              const cachedAiAssessment = !currentAssessment
                ? pendingAssessment
                : !pendingAssessment || currentAssessment.savedAt >= pendingAssessment.savedAt
                  ? currentAssessment
                  : pendingAssessment;
              const currentGrading = current.items[itemIndex]?.pendingGrading;
              const pendingGrading = item.pendingGrading;
              const durableGrading = !currentGrading
                ? pendingGrading
                : !pendingGrading || currentGrading.savedAt >= pendingGrading.savedAt
                  ? currentGrading
                  : pendingGrading;
              const settledGrading = gradedPartIds.has(item.partId)
                ? {
                    grading: null,
                    savedAt: [currentGrading?.savedAt, pendingGrading?.savedAt, snapshot.savedAt]
                      .filter((value): value is string => value !== undefined)
                      .sort()
                      .at(-1)!,
                  }
                : durableGrading;
              const answerDraft = mergeAnswerDraft(
                currentItem?.answerDraft,
                item.answerDraft,
                gradedPartIds.has(item.partId),
                snapshot.savedAt,
              );
              const {
                cachedAiHelp: _legacyHelp,
                answerDraft: _pendingAnswerDraft,
                ...itemWithoutLegacyHelp
              } = item;
              return {
                ...itemWithoutLegacyHelp,
                ...(deliveredHintLevel ? { deliveredHintLevel } : {}),
                ...(cachedAiHint ? { cachedAiHint: { ...cachedAiHint } } : {}),
                ...(cachedAiDiagnosis ? { cachedAiDiagnosis: { ...cachedAiDiagnosis } } : {}),
                ...(cachedAiAssessment ? { cachedAiAssessment: { ...cachedAiAssessment } } : {}),
                ...(settledGrading ? { pendingGrading: { ...settledGrading } } : {}),
                ...(answerDraft ? { answerDraft } : {}),
              };
            }),
            graded: mergedGraded,
            ...mergeSessionDraft(current, snapshot),
            savedAt: current.savedAt > snapshot.savedAt ? current.savedAt : snapshot.savedAt,
          };
        } else if (!replaceExisting) {
          throw new Error('Stored practice session was replaced by another programme');
        }
      }
      try {
        // A cancelled request may have been suspended in the revision read.
        // Recheck immediately before the durable replacement, not just before
        // entering this transaction loop. Once COMMIT starts, keep its result.
        assertContentLoadCurrent();
        const committed = await storage.commitBatch({
          ifRevisions: [{ ...address, revision: entry.revision }],
          mutations: [{ ...address, operation: 'set', value: next }],
        });
        if (committed.committed) return next;
      } catch (cause) {
        // The browser/IPC may lose the response after COMMIT. A matching
        // session containing every grade from this snapshot is already a
        // safe outcome; otherwise the caller must surface the storage error.
        const [durable] = await storage.readBatch([address]).catch(() => []);
        const durableSession = durable?.value;
        if (
          durable
          && isPersistedPracticeSession(durableSession)
          && sameSessionDefinition(durableSession, snapshot)
          && snapshot.graded.every((record) =>
            durableSession.graded.some((saved) =>
              saved.clientAttemptId === record.clientAttemptId))
        ) {
          return durableSession;
        }
        throw cause;
      }
    }
    throw new Error('Practice session changed too often to save safely');
  }

  async function persistSession(options: { replaceExisting?: boolean } = {}): Promise<boolean> {
    if (phase.value !== 'running' || items.value.length === 0) return false;
    const owner = await ensureSessionIdentity();
    assertContentLoadCurrent();
    if (!activeProfileCanAccessSession()) return false;
    const key = sessionStorageKey!;
    const snapshot = buildPersistedSession(owner, graded.value, new Date().toISOString());
    try {
      const committed = await enqueueSessionPersistence(() => {
        assertContentLoadCurrent();
        return commitSessionSnapshot(key, snapshot, options.replaceExisting === true);
      });
      assertContentLoadCurrent();
      items.value = committed.items.map(cloneSessionItem);
      graded.value = committed.graded.map(cloneGradedRecord);
      draftRevision.value = committed.draftRevision ?? 0;
      selfAssessmentDraft.value = committed.selfAssessmentDraft
        ? cloneSelfAssessmentDraft(committed.selfAssessmentDraft)
        : undefined;
      lastActivityAt.value = committed.savedAt;
      sessionIdentityDurable.value = true;
      return true;
    } catch {
      assertContentLoadCurrent();
      warning.value = 'Das laufende Programm konnte lokal nicht gespeichert werden.';
      return false;
    }
  }

  async function clearPersistedSession(): Promise<void> {
    const key = sessionStorageKey;
    // An auth/profile switch can leave an old Pinia instance alive for a few
    // frames. Never let the newly active account abort or expire somebody
    // else's durable programme through that stale in-memory reference.
    if (!key || !activeProfileCanAccessSession()) return;
    try {
      await enqueueSessionPersistence(() => storage.delete(STORAGE.app, key));
      selfAssessmentDraft.value = undefined;
      draftRevision.value = 0;
      pendingGradeRecords.clear();
    } catch {
      warning.value = 'Der lokal gespeicherte Programmstand konnte nicht entfernt werden.';
    }
  }

  const total = computed(() => items.value.length);
  const sessionAccessible = computed(() => {
    // Auth publishes only after its matching local profile is active. Reading
    // the reactive identity here makes an external login/logout immediately
    // re-evaluate this otherwise non-reactive profile-store check.
    void useAuthStore().session?.user.id;
    return !sessionOwner || activeProfileCanAccessSession();
  });
  const current = computed(() => {
    if (!sessionAccessible.value) return undefined;
    const item = items.value[index.value];
    if (!item) return undefined;
    const question = questions.value.get(item.questionId);
    const part = question?.parts.find((p) => p.id === item.partId);
    if (!question || !part) return undefined;
    return { item, question, part };
  });

  /** A current first attempt can remain on screen for one crash-safe correction. */
  const currentReview = computed(() => {
    if (!sessionAccessible.value) return undefined;
    const item = items.value[index.value];
    if (!item) return undefined;
    return graded.value.find((record) => record.partId === item.partId);
  });
  const currentSelfAssessmentDraft = computed(() => {
    if (!sessionAccessible.value) return undefined;
    const item = items.value[index.value];
    const draft = selfAssessmentDraft.value;
    if (!item || !draft || draft.partId !== item.partId) return undefined;
    if (graded.value.some((record) => record.partId === item.partId)) return undefined;
    return cloneSelfAssessmentDraft(draft);
  });
  const currentPendingGrading = computed<Grading | null>(() => {
    if (!sessionAccessible.value) return null;
    return items.value[index.value]?.pendingGrading?.grading ?? null;
  });
  const currentAnswerDraft = computed<Submission | undefined>(() => {
    if (!sessionAccessible.value) return undefined;
    const item = items.value[index.value];
    if (!item || graded.value.some((record) => record.partId === item.partId)) return undefined;
    return item.answerDraft?.submission
      ? cloneSubmission(item.answerDraft.submission)
      : undefined;
  });

  function correctionStillOpen(record: GradedRecord | undefined): record is GradedRecord {
    return !!record
      && record.result.verdict !== 'correct'
      && record.correctionOutcome === undefined
      && record.correctionClosedAt === undefined;
  }

  const summary = computed(() => {
    const list = sessionAccessible.value ? graded.value : [];
    const points = list.reduce((s, g) => s + g.result.awardedPoints, 0);
    const maxPoints = list.reduce((s, g) => s + g.result.maxPoints, 0);
    const byVerdict = { correct: 0, partial: 0, incorrect: 0 };
    for (const g of list) byVerdict[g.result.verdict]++;
    const correctionEligible = list.filter((record) => record.result.verdict !== 'correct').length;
    const correctionCorrect = list.filter((record) => record.correctionOutcome === 'correct').length;
    const corrections = {
      eligible: correctionEligible,
      attempted: list.filter((record) => record.correctionOutcome !== undefined).length,
      correct: correctionCorrect,
      unresolved: Math.max(0, correctionEligible - correctionCorrect),
    };
    const codes = new Set<string>();
    for (const g of list) {
      const q = questions.value.get(g.questionId);
      const part = q?.parts.find((p) => p.id === g.partId);
      for (const c of part?.competencies ?? []) codes.add(c.code);
    }
    return { count: list.length, points, maxPoints, byVerdict, corrections, competencies: [...codes] };
  });

  /**
   * Load full questions, cache-first. When the network fetch fails but SOME
   * questions are already cached (e.g. core briefly unreachable), the session
   * proceeds with the cached subset and a warning instead of hard-failing;
   * with nothing usable the error propagates.
   */
  async function fetchQuestions(ids: string[]): Promise<void> {
    const client = sessionCoreClient ?? await bindSessionContent();
    const unique = [...new Set(ids)];
    const missing: string[] = [];
    const map = new Map<string, Question>();
    const manifest = sessionManifestUnavailable ? undefined : sessionManifest;
    if (manifest) {
      if (!manifest.commit || typeof manifest.commit !== 'string') {
        throw new ContentIntegrityError('Die Aufgabenbank hat keine überprüfbare Versionskennung geliefert.');
      }
      if (contentId.value && manifest.commit !== contentId.value) {
        throw new ContentIntegrityError('Die Aufgabenbank wurde während des Ladens gewechselt.');
      }
      contentId.value = manifest.commit;
    }
    const cacheScope = manifest?.commit ?? contentId.value;
    for (const id of unique) {
      // Legacy manifest items authenticate Core's contentHash. Manifest v2's
      // rawSha256 instead authenticates the exact repository file bytes; the
      // wireSha256 is the proof available for a parsed Question response.
      const expectedHash = manifest?.formatVersion === 2 ? undefined : manifest?.items[id];
      // Strict sessions never reuse a legacy plain Question. getVerified
      // requires one atomic revision/raw-hash/wire-hash envelope and checks
      // the wire payload again on every read.
      const cached = cacheScope && (
        !manifest || manifest.formatVersion === 2 || isSha256(expectedHash)
      )
        ? await questionCache.getVerified(id, cacheScope, expectedHash)
        : undefined;
      assertContentLoadCurrent();
      if (!cached) {
        missing.push(id);
        continue;
      }
      if (manifest) assertQuestionMatchesManifest(manifest, cached);
      map.set(id, cached);
    }
    const fetched: ContentQuestion[] = [];
    if (missing.length > 0) {
      // No manifest means there is no authority against which a new payload
      // can be admitted. Only already-proven scoped envelopes above survive.
      if (!manifest) {
        throw new ContentIntegrityError(
          'Die Aufgabenbank konnte nicht überprüft werden. Neue Aufgaben werden aus Sicherheitsgründen nicht geladen.',
        );
      }
      let batchPayloadReceived = false;
      try {
        const res = contentMode.value === 'revision'
          ? await client.getRevisionQuestionsBatch(manifest.commit, missing)
          : await client.getQuestionsBatch(missing);
        assertContentLoadCurrent();
        batchPayloadReceived = true;
        const requested = new Set(missing);
        const returned = new Set<string>();
        for (const entry of res.questions) {
          const q = entry?.question;
          if (!q || typeof q.id !== 'string') {
            throw new ContentIntegrityError('Der Core hat eine ungültige Batch-Antwort geliefert.');
          }
          if (!requested.has(q.id)) {
            throw new ContentIntegrityError(
              t('Der Core hat eine nicht angeforderte Aufgabe geliefert ({id}).', { id: q.id }),
            );
          }
          if (returned.has(q.id)) {
            throw new ContentIntegrityError(t('Der Core hat Aufgabe {id} doppelt geliefert.', { id: q.id }));
          }
          returned.add(q.id);
          const expectedHash = manifest.formatVersion === 2 ? undefined : manifest.items[q.id];
          if (!isSha256(entry.contentHash) || !isSha256(entry.wireHash)) {
            throw new ContentIntegrityError(
              t('Der Core hat für Aufgabe {id} keine überprüfbaren Prüfsummen geliefert.', { id: q.id }),
            );
          }
          if (
            manifest.formatVersion !== 2
            && (!isSha256(expectedHash) || entry.contentHash !== expectedHash)
          ) {
            throw new ContentIntegrityError(
              t('Die Inhalts-Prüfsumme von Aufgabe {id} stimmt nicht mit der Aufgabenbank überein.', { id: q.id }),
            );
          }
          if (questionContentHash(q) !== entry.wireHash) {
            throw new ContentIntegrityError(
              t('Die Übertragungs-Prüfsumme von Aufgabe {id} ist ungültig.', { id: q.id }),
            );
          }
          assertQuestionMatchesManifest(manifest, q, entry.wireHash);
          fetched.push(entry);
        }
        const reportedMissing = new Set(res.missing);
        if (
          reportedMissing.size !== res.missing.length
          ||
          res.missing.some((id) => !requested.has(id) || returned.has(id))
          || missing.some((id) => !returned.has(id) && !reportedMissing.has(id))
        ) {
          throw new ContentIntegrityError('Die Batch-Antwort des Core ist unvollständig oder widersprüchlich.');
        }
        if (reportedMissing.size > 0) {
          warning.value = t('{count} Aufgaben sind in dieser Bank nicht verfügbar.', { count: reportedMissing.size });
        }
      } catch (e) {
        assertContentLoadCurrent();
        // Hash/revision failures are evidence of mixed content, not an
        // ordinary outage. Invalid stale entries must never be resurrected.
        if (e instanceof ContentIntegrityError) throw e;
        if (e instanceof CoreProtocolError) {
          throw new ContentIntegrityError(
            'Der Core unterstützt die erforderliche sichere Aufgabenübertragung nicht.',
            { cause: e },
          );
        }
        // Once a manifest-backed batch arrived, admitting any of it requires
        // the post-download revision confirmation. A failed confirmation is
        // intentionally fail-closed; otherwise figures could come from a
        // newer deployment than the cached question text.
        if (batchPayloadReceived) throw e;
        if (map.size === 0) throw e;
        const unavailable = unique.length - map.size;
        warning.value = t('{count} Aufgaben konnten nicht geladen werden — Programm läuft mit {saved} geprüften gespeicherten weiter.', { count: unavailable, saved: map.size });
      }
    }

    for (const entry of fetched) map.set(entry.question.id, entry.question);

    // Every manifest-backed session uses Core's immutable revision asset
    // route, including a session that otherwise reads the current question
    // endpoint. Afterwards these sessions expose only blob: URLs, so text and
    // figures cannot cross revisions.
    let pendingAssets = new Map<string, Blob>();
    if (contentSource.value === 'remote' || contentMode.value === 'revision') {
      const hasAssets = [...map.values()].some((question) => questionAssetPaths(question).length > 0);
      if (hasAssets && !manifest) {
        throw new ContentIntegrityError(
          'Die Version der Remote-Aufgabengrafiken konnte nicht bestätigt werden.',
        );
      }
      if (hasAssets) {
        pendingAssets = await prepareAssetSnapshot(
          client,
          map,
          manifest!.commit,
          manifest!,
          contentMode.value,
        );
        assertContentLoadCurrent();
      }
    }
    if (fetched.length > 0 || pendingAssets.size > 0) {
      let confirmed: ManifestResponse;
      try {
        confirmed = contentMode.value === 'revision'
          ? await client.revisionManifest(manifest!.commit)
          : await client.manifest();
        assertContentLoadCurrent();
      } catch (cause) {
        assertContentLoadCurrent();
        throw new ContentIntegrityError(
          'Die Aufgabenbank konnte nach dem Laden nicht erneut bestätigt werden.',
          { cause },
        );
      }
      const changed = confirmed.commit !== manifest?.commit
        || unique.some((id) => confirmed.items[id] !== manifest?.items[id])
        || (
          manifest?.formatVersion === 2
          && (
            confirmed.formatVersion !== 2
            || confirmed.bank.rootSha256 !== manifest.bank.rootSha256
            || confirmed.bank.immutableAssetBaseUrl !== manifest.bank.immutableAssetBaseUrl
          )
        );
      if (changed) {
        throw new ContentIntegrityError(
          'Die Aufgabenbank wurde während des Ladens aktualisiert. Bitte lade das Programm erneut.',
        );
      }
      sessionManifest = confirmed;
    }

    if (contentSource.value === 'remote' || contentMode.value === 'revision') {
      assertContentLoadCurrent();
      commitPinnedAssets(pendingAssets);
    }
    if (fetched.length > 0 && cacheScope) {
      await questionCache.putManyVerified(fetched, cacheScope);
      assertContentLoadCurrent();
      // The unscoped cache is a current-bank title compatibility index. A
      // historical replay must never overwrite it with an old title.
      if (contentMode.value === 'current') {
        await questionCache.putMany(fetched.map((entry) => entry.question));
        assertContentLoadCurrent();
      }
    }
    questions.value = map;
  }

  async function beginSession(list: SessionItem[], from: SessionOrigin): Promise<void> {
    await ensureSessionIdentity();
    assertContentLoadCurrent();
    if (!activeProfileCanAccessSession()) {
      throw new Error('Das Konto wurde während des Ladens gewechselt.');
    }
    sessionIdentityDurable.value = false;
    items.value = normalizeSessionItems(list);
    origin.value = from;
    lastActivityAt.value = new Date().toISOString();
    index.value = 0;
    graded.value = [];
    selfAssessmentDraft.value = undefined;
    draftRevision.value = 0;
    pendingGradeRecords.clear();
    preAnswerFsrs.clear();
    phase.value = items.value.length > 0 ? 'running' : 'summary';
    partShownAt.value = Date.now();
    if (items.value.length > 0) await persistSession({ replaceExisting: true });
    else await clearPersistedSession();
  }

  /**
   * Bulk practice handoff (URL-bloat fix): the browse page seeds the session
   * IN THE STORE. One durable attempt identity links the route to exactly this
   * programme, without putting hundreds of question ids in the URL.
   */
  async function startPrepared(
    questionIds: string[],
    fixedSource = useAppStore().coreEndpointSource,
    expectedContentId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const ids = [...new Set(questionIds)];
    return runContentLoad(async () => {
      await startQuestionsNow(ids, fixedSource, expectedContentId, { requireCompleteSelection: true });
      assertContentLoadCurrent();
      if (phase.value !== 'running' || !sessionIdentityDurable.value) {
        throw new Error(error.value ?? warning.value ?? 'Übung konnte nicht gestartet werden. Bitte erneut versuchen.');
      }
      const preparedId = items.value[0]?.clientAttemptId;
      if (!preparedId) throw new Error('Das laufende Programm konnte lokal nicht gespeichert werden.');
      return preparedId;
    }, signal);
  }

  function startSmart(opts?: { count?: number; filters?: QuestionsFilter }, fixedSource = useAppStore().coreEndpointSource, expectedContentId?: string): Promise<void> {
    return runContentLoad(() => startSmartNow(opts, fixedSource, expectedContentId));
  }

  /** Smart session: FSRS-due reviews + weak-competency new parts (core decides). */
  async function startSmartNow(
    opts?: { count?: number; filters?: QuestionsFilter },
    fixedSource = useAppStore().coreEndpointSource,
    expectedContentId?: string,
  ): Promise<void> {
    // Capture the source synchronously with the click. Another Desktop window
    // may change the device preference while owner reconciliation is awaiting
    // storage, but this programme must still start from the source the user saw.
    const requestedSource = fixedSource;
    // Session ownership begins with the user's start action, before any fetch
    // or reconciliation await can let a different window change auth.
    const owner = await useProgressStore().captureAttemptOwner();
    assertContentLoadCurrent();
    setSessionIdentity(owner);
    pendingExactRestore = undefined;
    lastRequest.value = opts
      ? { kind: 'smart', source: requestedSource, opts, ...(expectedContentId ? { contentId: expectedContentId } : {}) }
      : { kind: 'smart', source: requestedSource, ...(expectedContentId ? { contentId: expectedContentId } : {}) };
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
      const app = useAppStore();
      const client = await bindSessionContent(requestedSource, expectedContentId);
      if (!activeProfileCanAccessSession()) {
        throw new Error('Das Konto wurde während des Ladens gewechselt.');
      }
      const progress = useProgressStore();
      // Logged in: reconcile with the cloud archive before asking for
      // recommendations (contract §8.2 step 2 — checksum compare inside).
      if (sessionResolvedOwnerId && progress.isActiveAccountOwner(sessionResolvedOwnerId)) {
        const syncResult = await progress.syncBeforeRecommendation();
        assertContentLoadCurrent();
        if (syncResult === 'conflict' || syncResult === 'blocked') {
          throw new Error('Bitte löse zuerst den offenen Speicherkonflikt. Danach kann das Programm starten.');
        }
        if (syncResult === 'offline') {
          warning.value = 'Cloud-Speicher nicht erreichbar — Empfehlungen basieren auf dem lokalen Fortschritt.';
        } else if (syncResult === 'error') {
          warning.value = 'Cloud-Abgleich fehlgeschlagen — Empfehlungen basieren auf dem lokalen Fortschritt.';
        }
      }
      if (!activeProfileCanAccessSession()) {
        throw new Error('Das Konto wurde während des Ladens gewechselt.');
      }
      const ownerProfile = sessionOwner?.localProfileId;
      if (!ownerProfile) throw new Error('Practice session has no local profile identity');
      const userState = await progress.toUserState(ownerProfile, {
        includeLearning: sessionLearningRecommendations,
      });
      assertContentLoadCurrent();
      if (!activeProfileCanAccessSession()) {
        throw new Error('Das Konto wurde während des Ladens gewechselt.');
      }
      const req: Parameters<CoreClient['recommend']>[0] = {
        userState,
        count: opts?.count ?? 20,
      };
      if (opts?.filters) req.filters = opts.filters;
      const rec = await client.recommend(req);
      assertContentLoadCurrent();
      await fetchQuestions(rec.items.map((i) => i.questionId));
      // Guards: playable parts only, and NEVER an excluded part (supplement
      // §1.4 — belt to the userState projection's braces).
      const excluded = progress.excludedPartIds;
      const list: SessionItem[] = rec.items.filter((i) => {
        if (excluded.has(i.partId)) return false;
        const q = questions.value.get(i.questionId);
        return q?.parts.some((p) => p.id === i.partId && p.answer);
      });
      await beginSession(list, 'smart');
    } catch (e) {
      enterFailClosedError(e);
    }
  }

  /**
   * Practice explicit questions (whole exam or a hand-picked set) —
   * user-driven, so excluded parts stay OPENABLE here when a single question
   * is chosen deliberately (supplement §1.4: exclusion is not deletion).
   * For bulk selections (more than one question) excluded parts are skipped.
   */
  function startQuestions(questionIds: string[], fixedSource = useAppStore().coreEndpointSource, expectedContentId?: string): Promise<void> {
    const ids = [...questionIds];
    return runContentLoad(() => startQuestionsNow(ids, fixedSource, expectedContentId));
  }

  async function startQuestionsNow(
    questionIds: string[],
    fixedSource = useAppStore().coreEndpointSource,
    expectedContentId?: string,
    options: { requireCompleteSelection?: boolean } = {},
  ): Promise<void> {
    const requestedSource = fixedSource;
    // Fix the same identity for question loading, answer commits and every
    // later snapshot; beginSession must not re-read live auth.
    const owner = await useProgressStore().captureAttemptOwner();
    assertContentLoadCurrent();
    setSessionIdentity(owner);
    pendingExactRestore = undefined;
    lastRequest.value = {
      kind: 'questions',
      source: requestedSource,
      ids: [...questionIds],
      ...(expectedContentId ? { contentId: expectedContentId } : {}),
    };
    phase.value = 'loading';
    error.value = undefined;
    warning.value = undefined;
    try {
      await bindSessionContent(requestedSource, expectedContentId);
      const progress = useProgressStore();
      await fetchQuestions(questionIds);
      if (options.requireCompleteSelection && questionIds.some((id) => !questions.value.has(id))) {
        throw new Error('Die Auswahl konnte nicht vollständig geladen werden. Bitte erneut versuchen.');
      }
      const excluded = progress.excludedPartIds;
      const deliberateSingle = questionIds.length === 1;
      const list: SessionItem[] = [];
      for (const id of questionIds) {
        const q = questions.value.get(id);
        for (const p of q?.parts ?? []) {
          if (!p.answer) continue;
          if (!deliberateSingle && excluded.has(p.id)) continue;
          list.push({ questionId: id, partId: p.id, reason: 'manual' });
        }
      }
      if (options.requireCompleteSelection && list.length === 0) {
        throw new Error('Keine passenden Aufgaben.');
      }
      await beginSession(list, 'manual');
    } catch (e) {
      enterFailClosedError(e);
    }
  }

  async function recordGraded(payload: {
    part: QuestionPart;
    result: GradeResult;
    submission: Submission;
    hintLevel?: LearningHintLevel;
    manualGrading?: Grading;
  }): Promise<GradedRecord | undefined> {
    const cur = current.value;
    if (!cur || cur.part.id !== payload.part.id) return;
    const progress = useProgressStore();
    const auth = useAuthStore();
    // The whole programme owns the event. Capturing from live auth here would
    // let a cross-window account switch put an old guest snapshot into a new
    // user's key even if the audit outbox itself retained the old owner.
    const attemptOwner = await ensureSessionIdentity();
    if (!activeProfileCanAccessSession()) {
      throw new Error('Dieses Programm gehört zu einem anderen lokalen Profil.');
    }
    const clientAttemptId = cur.item.clientAttemptId;
    if (!clientAttemptId) throw new Error('Practice item has no reserved attempt identity');
    const pending = pendingGradeRecords.get(clientAttemptId);
    if (pending && (
      JSON.stringify(pending.record.result) !== JSON.stringify(payload.result)
      || pending.manualGrading !== payload.manualGrading
    )) {
      throw new Error('The pending answer changed after its durable commit started');
    }
    const record: GradedRecord = pending
      ? cloneGradedRecord(pending.record)
      : (() => {
          const keepSubmission = payload.result.verdict !== 'correct'
            && isPersistableSubmission(payload.submission);
          return {
            clientAttemptId,
            partId: payload.part.id,
            questionId: cur.question.id,
            result: payload.result,
            reason: cur.item.reason,
            gradedAt: new Date().toISOString(),
            elapsedMs: Math.max(0, Date.now() - partShownAt.value),
            ...(payload.hintLevel ? { hintLevel: payload.hintLevel } : {}),
            ...(keepSubmission ? { pendingSubmission: cloneSubmission(payload.submission) } : {}),
          };
        })();
    if (!pending) {
      pendingGradeRecords.set(clientAttemptId, {
        record: cloneGradedRecord(record),
        ...(payload.manualGrading ? { manualGrading: payload.manualGrading } : {}),
      });
    }
    const nextGraded = [...graded.value, record];
    const key = sessionStorageKey;
    if (!key) throw new Error('Practice session has no durable storage identity');
    // Drain earlier position-only snapshots before taking the revisioned batch
    // snapshot. They may fail, but they can never race and overwrite the grade
    // after its transaction commits.
    await sessionPersistenceTail;
    const savedAt = new Date().toISOString();
    const draftForPart = selfAssessmentDraft.value?.partId === payload.part.id
      ? selfAssessmentDraft.value
      : undefined;
    const clearedDraftRevision = draftForPart ? draftRevision.value + 1 : draftRevision.value;
    const nextSession = buildPersistedSession(attemptOwner, nextGraded, savedAt, {
      revision: clearedDraftRevision,
      ...(!draftForPart && selfAssessmentDraft.value
        ? { draft: selfAssessmentDraft.value }
        : {}),
    });
    nextSession.items = nextSession.items.map((item) => item.partId === payload.part.id
      ? {
          ...item,
          pendingGrading: { grading: null, savedAt },
          answerDraft: {
            revision: (item.answerDraft?.revision ?? 0) + 1,
            savedAt,
          },
        }
      : item);
    let committed;
    try {
      committed = await progress.commitGradeEvent({
        owner: attemptOwner,
        attempt: toAttemptRecord(record),
        grade: {
          partId: payload.part.id,
          competencyCodes: payload.part.competencies.map((competency) => competency.code),
          verdict: payload.result.verdict,
          awardedPoints: payload.result.awardedPoints,
          maxPoints: payload.result.maxPoints,
          now: new Date(record.gradedAt),
        },
        ...(payload.manualGrading ? { manualGrading: payload.manualGrading } : {}),
        session: {
          address: { collection: STORAGE.app, key },
          prepare(current, context) {
            const preparedNext: PersistedPracticeSession = {
              ...nextSession,
              graded: nextSession.graded.map((candidate) =>
                candidate.clientAttemptId === clientAttemptId
                  ? cloneGradedRecord({
                      ...candidate,
                      gradingBaseCaptured: true,
                      ...(context.previousFsrs
                        ? { preAnswerFsrs: { ...context.previousFsrs } }
                        : {}),
                    })
                  : cloneGradedRecord(candidate)),
            };
            if (current !== undefined) {
              if (!isPersistedPracticeSession(current)) {
                throw new Error('Stored practice session is malformed');
              }
              const owner = current.version >= 3 ? current.owner : undefined;
              if (
                owner
                && (owner.userId !== attemptOwner.userId
                  || owner.guestGeneration !== attemptOwner.guestGeneration)
              ) {
                throw new Error('Stored practice session belongs to a different account');
              }
              if (!sameSessionDefinition(current, preparedNext)) {
                throw new Error('Stored practice session was replaced by another programme');
              }
              const draftState = mergeSessionDraft(current, preparedNext);
              if (draftState.selfAssessmentDraft?.partId === payload.part.id) {
                throw new Error('A self-assessment draft changed in another window');
              }
              const { selfAssessmentDraft: _nextDraft, ...nextWithoutDraft } = preparedNext;
              const mergedGraded = mergeSessionGradeRecords(current.graded, preparedNext.graded);
              const gradedPartIds = new Set(mergedGraded.map((record) => record.partId));
              return {
                ...nextWithoutDraft,
                items: preparedNext.items.map((item, itemIndex) => {
                  const answerDraft = mergeAnswerDraft(
                    current.items[itemIndex]?.answerDraft,
                    item.answerDraft,
                    gradedPartIds.has(item.partId),
                    preparedNext.savedAt,
                  );
                  const { answerDraft: _pendingAnswerDraft, ...withoutAnswerDraft } = item;
                  return {
                    ...withoutAnswerDraft,
                    ...(answerDraft ? { answerDraft } : {}),
                  };
                }),
                graded: mergedGraded,
                ...draftState,
                  savedAt: current.savedAt > preparedNext.savedAt ? current.savedAt : preparedNext.savedAt,
              };
            }
            return preparedNext;
          },
          containsAttempt(current, clientAttemptId) {
            return isPersistedPracticeSession(current)
              && current.graded.some((candidate) => candidate.clientAttemptId === clientAttemptId);
          },
          matchesAttempt(current, attempt) {
            if (!isPersistedPracticeSession(current)) return false;
            const record = current.graded.find(
              (candidate) => candidate.clientAttemptId === attempt.clientAttemptId,
            );
            return !!record && JSON.stringify(toAttemptRecord(record)) === JSON.stringify(attempt);
          },
        },
      });
    } catch (cause) {
      // The item reserves one logical attempt for every renderer. If another
      // window reached storage first with a different answer, adopt that
      // durable winner instead of retrying the same id forever or advancing
      // FSRS a second time.
      const durable = await storage.get<unknown>(STORAGE.app, key).catch(() => undefined);
      if (!isPersistedPracticeSession(durable) || !sameSessionDefinition(durable, nextSession)) {
        throw cause;
      }
      const winner = durable.graded.find((candidate) => candidate.clientAttemptId === clientAttemptId);
      if (!winner) throw cause;
      graded.value = durable.graded.map(cloneGradedRecord);
      items.value = durable.items.map(cloneSessionItem);
      draftRevision.value = durable.draftRevision ?? draftRevision.value;
      selfAssessmentDraft.value = durable.selfAssessmentDraft
        ? cloneSelfAssessmentDraft(durable.selfAssessmentDraft)
        : undefined;
      pendingGradeRecords.delete(clientAttemptId);
      lastActivityAt.value = durable.savedAt;
      sessionIdentityDurable.value = true;
      if (winner.gradingBaseCaptured) {
        preAnswerFsrs.set(winner.partId, winner.preAnswerFsrs);
      }
      return cloneGradedRecord(winner);
    }
    // Nothing reactive changes before all four durable records are committed.
    if (!isPersistedPracticeSession(committed.session)) {
      throw new Error('Committed practice session is malformed');
    }
    sessionResolvedOwnerId = committed.ownerId;
    graded.value = committed.session.graded.map(cloneGradedRecord);
    items.value = committed.session.items.map(cloneSessionItem);
    draftRevision.value = committed.session.draftRevision ?? clearedDraftRevision;
    selfAssessmentDraft.value = committed.session.selfAssessmentDraft
      ? cloneSelfAssessmentDraft(committed.session.selfAssessmentDraft)
      : undefined;
    pendingGradeRecords.delete(clientAttemptId);
    lastActivityAt.value = committed.session.savedAt;
    const durableRecord = graded.value.find((candidate) => candidate.clientAttemptId === clientAttemptId);
    preAnswerFsrs.set(payload.part.id, durableRecord?.preAnswerFsrs ?? committed.previousFsrs);
    const learningProfile = attemptOwner.localProfileId;
    if (learningProfile) {
      try {
        await learningEventStore.recordFirst(learningProfile, record.clientAttemptId, {
          version: 1,
          partId: record.partId,
          outcome: record.result.verdict,
          ...(record.hintLevel ? { hintLevel: record.hintLevel } : {}),
          ...(contentId.value ? { contentId: contentId.value } : {}),
          at: record.gradedAt,
        });
      } catch {
        warning.value = 'Die Korrektur-Empfehlung konnte lokal nicht gespeichert werden.';
      }
    }
    // Guests retain the staged event under their local-only owner. Authenticated
    // attempts flush only if the same captured account is still active.
    void progress.flushStagedAttempt(committed.ownerId).catch(() => {
      progress.scheduleCloudRecovery();
    });
    if (progress.isActiveAccountOwner(committed.ownerId) && graded.value.length % SYNC_EVERY_N_GRADES === 0) {
      void progress.syncNow({ quiet: true });
    }
    return graded.value.find((candidate) => candidate.clientAttemptId === record.clientAttemptId);
  }

  /** Repair only the requested attempt, never replay grading or historical rows. */
  async function recoverLearningEvent(
    profileId: LocalProfileId,
    record: GradedRecord,
    snapshot?: PersistedPracticeSession,
  ): Promise<LearningEvent | undefined> {
    if (sessionOwner?.localProfileId !== profileId || !activeProfileCanAccessSession()) {
      throw new Error('Dieses Programm gehört zu einem anderen lokalen Profil.');
    }
    const existing = await learningEventStore.event(profileId, record.clientAttemptId);
    if (existing) return existing;
    const saved = snapshot ?? (sessionStorageKey
      ? await storage.get<unknown>(STORAGE.app, sessionStorageKey)
      : undefined);
    if (!isPersistedPracticeSession(saved)
      || !hasExactContentProvenance(saved)
      || saved.owner?.localProfileId !== profileId) return undefined;
    const savedRecord = saved.graded.find((candidate) => candidate.clientAttemptId === record.clientAttemptId
        && candidate.partId === record.partId
        && candidate.questionId === record.questionId
        && candidate.gradedAt === record.gradedAt
        && candidate.result.verdict === record.result.verdict);
    if (!savedRecord) return undefined;
    const historyValue = await storage.get<unknown>(
      STORAGE.history,
      historyEventRowKey(record.clientAttemptId, profileId),
    );
    if (historyValue === undefined) return undefined;
    const history = parseStoredHistoryEvent(historyValue);
    // A legacy session can be explicitly reopened against today's bank. Its
    // rewritten snapshot alone cannot prove the original attempt's revision.
    if (history.profileId !== profileId
      || history.entry.clientAttemptId !== record.clientAttemptId
      || history.entry.partId !== record.partId
      || history.entry.questionId !== record.questionId
      || history.entry.gradedAt !== record.gradedAt
      || history.entry.verdict !== record.result.verdict
      || history.entry.contentSource !== saved.contentSource
      || history.entry.contentId !== saved.contentId) return undefined;
    const event: LearningEvent = {
      version: 1,
      partId: record.partId,
      outcome: record.result.verdict,
      ...(savedRecord.hintLevel ? { hintLevel: savedRecord.hintLevel } : {}),
      contentId: saved.contentId,
      at: record.gradedAt,
    };
    if (sessionOwner?.localProfileId !== profileId || !activeProfileCanAccessSession()) {
      throw new Error('Dieses Programm gehört zu einem anderen lokalen Profil.');
    }
    try {
      await learningEventStore.recordFirst(profileId, record.clientAttemptId, event);
    } catch (cause) {
      // Another window may have inserted and enriched this same first event
      // between our read and CAS. Preserve that evidence rather than replace it.
      const durable = await learningEventStore.event(profileId, record.clientAttemptId);
      if (!durable || durable.partId !== event.partId || durable.outcome !== event.outcome
        || durable.at !== event.at || durable.hintLevel !== event.hintLevel
        || durable.contentId !== event.contentId) throw cause;
      return durable;
    }
    return learningEventStore.event(profileId, record.clientAttemptId);
  }

  /** A correction is learning evidence, not another spaced-repetition event. */
  async function recordCorrection(
    clientAttemptId: string,
    partId: string,
    result: GradeResult,
  ): Promise<GradedRecord | undefined> {
    const recordIndex = graded.value.findIndex((candidate) =>
      candidate.clientAttemptId === clientAttemptId && candidate.partId === partId);
    const record = graded.value[recordIndex];
    const profileId = sessionOwner?.localProfileId;
    if (!record || !profileId) return;
    if (record.correctionOutcome) {
      if (record.correctionOutcome !== result.verdict) {
        throw new Error('Eine andere Ansicht hat bereits eine andere Korrektur gespeichert.');
      }
      return cloneGradedRecord(record);
    }
    if (record.correctionClosedAt) {
      throw new Error('Diese Korrektur wurde bereits in einer anderen Ansicht abgeschlossen.');
    }
    const correctedAt = new Date().toISOString();
    const {
      pendingSubmission: _privateAnswer,
      correctionDraft: _correctionDraft,
      correctionClosedAt: _closedReview,
      ...withoutPrivateAnswer
    } = record;
    const nextGraded = graded.value.map((candidate, index) => index === recordIndex
      ? cloneGradedRecord({
          ...withoutPrivateAnswer,
          correctionOutcome: result.verdict,
          correctedAt,
        })
      : candidate);
    const owner = await ensureSessionIdentity();
    const key = sessionStorageKey;
    if (!key) throw new Error('Practice session has no durable storage identity');
    const snapshot = buildPersistedSession(owner, nextGraded, correctedAt);
    const committed = await enqueueSessionPersistence(() => commitSessionSnapshot(key, snapshot, false));
    graded.value = committed.graded.map(cloneGradedRecord);
    lastActivityAt.value = committed.savedAt;
    sessionIdentityDurable.value = true;
    const durable = graded.value.find((candidate) => candidate.clientAttemptId === record.clientAttemptId);
    if (!durable || durable.correctionOutcome !== result.verdict) {
      throw new Error('Eine andere Ansicht hat bereits eine andere Korrektur gespeichert.');
    }
    // Recommendation evidence is optional telemetry. A failure never rolls
    // back or hides the already durable correction.
    try {
      await recoverLearningEvent(profileId, durable, committed);
      await learningEventStore.recordCorrection(profileId, record.clientAttemptId, result.verdict);
    } catch {
      warning.value = 'Die Korrektur-Empfehlung konnte lokal nicht aktualisiert werden.';
    }
    return cloneGradedRecord(durable);
  }

  async function saveCorrectionDraft(
    clientAttemptId: string,
    partId: string,
    submission: Submission,
  ): Promise<boolean> {
    if (!isPersistableSubmission(submission)) throw new TypeError('Correction draft is malformed');
    const recordIndex = graded.value.findIndex((candidate) =>
      candidate.clientAttemptId === clientAttemptId && candidate.partId === partId);
    const record = graded.value[recordIndex];
    if (!record || record.correctionOutcome || record.correctionClosedAt) return false;
    if (
      record.correctionDraft
      && JSON.stringify(record.correctionDraft.submission) === JSON.stringify(submission)
    ) return true;
    const previous = graded.value;
    const previousMs = record.correctionDraft
      ? Date.parse(record.correctionDraft.savedAt)
      : Number.NEGATIVE_INFINITY;
    const savedAt = new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
    const draft = { submission: cloneSubmission(submission), savedAt };
    graded.value = graded.value.map((candidate, index) => index === recordIndex
      ? cloneGradedRecord({ ...candidate, correctionDraft: draft })
      : candidate);
    if (!(await persistSession())) {
      graded.value = previous;
      return false;
    }
    const durable = graded.value.find((candidate) => candidate.clientAttemptId === clientAttemptId);
    return JSON.stringify(durable?.correctionDraft?.submission) === JSON.stringify(submission);
  }

  async function recordDiagnosis(
    clientAttemptId: string,
    partId: string,
    errorCode: AiDiagnosisCode,
  ): Promise<void> {
    const record = graded.value.find((candidate) =>
      candidate.clientAttemptId === clientAttemptId && candidate.partId === partId);
    const profileId = sessionOwner?.localProfileId;
    if (!record || !profileId) return;
    try {
      await recoverLearningEvent(profileId, record);
      await learningEventStore.recordDiagnosis(profileId, record.clientAttemptId, errorCode);
    } catch {
      warning.value = 'Die Fehlerdiagnose konnte lokal nicht gespeichert werden.';
    }
  }

  async function recordHintLevel(partId: string, level: LearningHintLevel): Promise<void> {
    const itemIndex = items.value.findIndex((candidate) => candidate.partId === partId);
    const item = items.value[itemIndex];
    if (!item || (item.deliveredHintLevel ?? 0) >= level) return;
    const previous = items.value;
    items.value = items.value.map((candidate, index) => index === itemIndex
      ? { ...candidate, deliveredHintLevel: level }
      : candidate);
    if (!(await persistSession())) {
      items.value = previous;
      throw new Error('Der Hinweis konnte lokal nicht gespeichert werden.');
    }
  }

  async function recordCachedAiHelp(partId: string, locator: AiExplainCacheLocator): Promise<void> {
    if (!isAiExplainCacheLocator(locator)) throw new TypeError('AI cache locator is malformed');
    const itemIndex = items.value.findIndex((candidate) => candidate.partId === partId);
    if (itemIndex < 0) return;
    const previous = items.value;
    items.value = items.value.map((candidate, index) => index === itemIndex
      ? locator.mode === 'hint'
        ? { ...candidate, cachedAiHint: { ...locator } }
        : { ...candidate, cachedAiDiagnosis: { ...locator } }
      : candidate);
    if (!(await persistSession())) {
      items.value = previous;
      throw new Error('Die gespeicherte Hilfe konnte dem Programm nicht zugeordnet werden.');
    }
  }

  /**
   * Persist a paid learning result as one session mutation. A hint's cache
   * locator and delivered level are one fact: writing them separately could
   * leave a crash-recovered session at level 2 with no way to replay level 1.
   */
  async function recordAiHelp(
    partId: string,
    locator: AiExplainCacheLocator,
    deliveredHintLevel?: LearningHintLevel,
  ): Promise<void> {
    if (!isAiExplainCacheLocator(locator) || locator.partId !== partId) {
      throw new TypeError('AI cache locator is malformed');
    }
    if (locator.mode === 'hint' && locator.hintLevel !== deliveredHintLevel) {
      throw new TypeError('AI hint locator and delivered level disagree');
    }
    if (locator.mode === 'diagnosis' && deliveredHintLevel !== undefined) {
      throw new TypeError('A diagnosis cannot advance the hint level');
    }
    const itemIndex = items.value.findIndex((candidate) => candidate.partId === partId);
    if (itemIndex < 0) return;
    const previous = items.value;
    items.value = items.value.map((candidate, index) => index === itemIndex
      ? {
          ...candidate,
          ...(locator.mode === 'hint'
            ? { cachedAiHint: { ...locator } }
            : { cachedAiDiagnosis: { ...locator } }),
          ...(deliveredHintLevel
            ? { deliveredHintLevel: Math.max(candidate.deliveredHintLevel ?? 0, deliveredHintLevel) as LearningHintLevel }
            : {}),
        }
      : candidate);
    if (!(await persistSession())) {
      items.value = previous;
      throw new Error('Die gespeicherte Hilfe konnte dem Programm nicht zugeordnet werden.');
    }
  }

  async function recordCachedAiAssessment(
    partId: string,
    locator: AiAssessCacheLocator,
  ): Promise<void> {
    if (!isAiAssessCacheLocator(locator) || locator.partId !== partId) {
      throw new TypeError('AI assessment cache locator is malformed');
    }
    const itemIndex = items.value.findIndex((candidate) => candidate.partId === partId);
    if (itemIndex < 0) return;
    const previous = items.value;
    items.value = items.value.map((candidate, index) => index === itemIndex
      ? { ...candidate, cachedAiAssessment: { ...locator } }
      : candidate);
    if (!(await persistSession())) {
      items.value = previous;
      throw new Error('Der gespeicherte KI-Vergleich konnte nicht zugeordnet werden.');
    }
  }

  async function savePendingGrading(partId: string, grading: Grading | null): Promise<boolean> {
    if (grading !== null && !isGrading(grading)) throw new TypeError('Invalid pending grading');
    const itemIndex = items.value.findIndex((candidate) => candidate.partId === partId);
    if (itemIndex < 0 || graded.value.some((record) => record.partId === partId)) return false;
    const previous = items.value;
    const previousSavedAt = items.value[itemIndex]?.pendingGrading?.savedAt;
    const previousMs = previousSavedAt ? Date.parse(previousSavedAt) : Number.NEGATIVE_INFINITY;
    const savedAt = new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
    items.value = items.value.map((candidate, index) => index === itemIndex
      ? { ...candidate, pendingGrading: { grading, savedAt } }
      : candidate);
    if (!(await persistSession())) {
      items.value = previous;
      return false;
    }
    return items.value[itemIndex]?.pendingGrading?.grading === grading;
  }

  function sameAnswerDraftSession(intent: AnswerDraftWriteIntent): boolean {
    return sessionStorageKey === intent.key
      && sessionOwner?.localProfileId === intent.owner.localProfileId
      && sessionOwner?.userId === intent.owner.userId
      && sessionOwner?.guestGeneration === intent.owner.guestGeneration
      && items.value.some((item) =>
        item.partId === intent.partId
        && (item.clientAttemptId ?? item.learningInteractionId) === intent.itemIdentity);
  }

  function adoptAnswerDraftSession(
    intent: AnswerDraftWriteIntent,
    committed: PersistedPracticeSession,
  ): boolean {
    if (!sameAnswerDraftSession(intent)) return false;
    items.value = committed.items.map(cloneSessionItem);
    graded.value = committed.graded.map(cloneGradedRecord);
    draftRevision.value = committed.draftRevision ?? 0;
    selfAssessmentDraft.value = committed.selfAssessmentDraft
      ? cloneSelfAssessmentDraft(committed.selfAssessmentDraft)
      : undefined;
    lastActivityAt.value = committed.savedAt;
    sessionIdentityDurable.value = true;
    return true;
  }

  async function commitAnswerDraftIntent(
    intent: AnswerDraftWriteIntent,
  ): Promise<{ outcome: AnswerDraftSaveOutcome; committed?: PersistedPracticeSession }> {
    try {
      const committed = await commitSessionSnapshot(intent.key, intent.snapshot, false);
      const winner = committed.graded.find((record) => record.partId === intent.partId);
      if (winner) {
        if (!sameAnswerDraftSession(intent)) return { outcome: { status: 'failed' } };
        return {
          outcome: { status: 'superseded-by-grade', record: cloneGradedRecord(winner) },
          committed,
        };
      }
      const durable = committed.items.find((item) => item.partId === intent.partId)?.answerDraft;
      return JSON.stringify(durable?.submission) === JSON.stringify(intent.submission)
        ? { outcome: { status: 'saved' }, committed }
        : { outcome: { status: 'failed' } };
    } catch {
      if (sameAnswerDraftSession(intent)) {
        warning.value = 'Der Antwortentwurf konnte lokal nicht gespeichert werden.';
      }
      return { outcome: { status: 'failed' } };
    }
  }

  async function saveAnswerDraft(
    partId: string,
    submission: Submission,
  ): Promise<AnswerDraftSaveOutcome> {
    if (!isPersistableSubmission(submission)) throw new TypeError('Answer draft is malformed');
    const currentItem = items.value[index.value];
    const owner = sessionOwner ? { ...sessionOwner } : undefined;
    const key = sessionStorageKey;
    const itemIdentity = currentItem?.clientAttemptId ?? currentItem?.learningInteractionId;
    if (
      phase.value !== 'running'
      || !currentItem
      || currentItem.partId !== partId
      || graded.value.some((record) => record.partId === partId)
      || !owner
      || !key
      || !itemIdentity
      || !activeProfileCanAccessSession()
    ) return { status: 'failed' };
    // Capture every routing/security input before yielding. An auth change or
    // unmount may hide this session, but cannot retarget the already queued
    // private draft to another profile.
    const previousMs = currentItem.answerDraft?.savedAt
      ? Date.parse(currentItem.answerDraft.savedAt)
      : Number.NEGATIVE_INFINITY;
    const savedAt = new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
    const draft = {
      revision: (currentItem.answerDraft?.revision ?? 0) + 1,
      submission: cloneSubmission(submission),
      savedAt,
    } satisfies NonNullable<SessionItem['answerDraft']>;
    items.value = items.value.map((item) => item.partId === partId
      ? { ...item, answerDraft: draft }
      : item);
    const snapshot = buildPersistedSession(owner, graded.value, savedAt);
    const lineageKey = `${key}\0${partId}\0${itemIdentity}`;
    const intent: AnswerDraftWriteIntent = {
      owner,
      key,
      partId,
      itemIdentity,
      submission: cloneSubmission(submission),
      snapshot,
    };
    const existing = answerDraftWritePipelines.get(lineageKey);
    if (existing) {
      existing.latest = intent;
      return new Promise((resolve) => { existing.waiters.push(resolve); });
    }

    const pipeline: AnswerDraftWritePipeline = { waiters: [] };
    answerDraftWritePipelines.set(lineageKey, pipeline);
    const outcome = new Promise<AnswerDraftSaveOutcome>((resolve) => {
      pipeline.waiters.push(resolve);
    });
    void enqueueSessionPersistence(async () => {
      let current = intent;
      let final: AnswerDraftSaveOutcome = { status: 'failed' };
      let finalCommitted: PersistedPracticeSession | undefined;
      for (;;) {
        const result = await commitAnswerDraftIntent(current);
        final = result.outcome;
        finalCommitted = result.committed;
        if (final.status !== 'saved') {
          pipeline.latest = undefined;
          break;
        }
        const latest = pipeline.latest;
        pipeline.latest = undefined;
        if (!latest) break;
        current = latest;
      }
      if (finalCommitted && (final.status === 'saved' || final.status === 'superseded-by-grade')) {
        adoptAnswerDraftSession(current, finalCommitted);
      }
      return final;
    }).then(
      (final) => {
        answerDraftWritePipelines.delete(lineageKey);
        for (const resolve of pipeline.waiters) resolve(final);
      },
      () => {
        answerDraftWritePipelines.delete(lineageKey);
        for (const resolve of pipeline.waiters) resolve({ status: 'failed' });
      },
    );
    return outcome;
  }

  async function saveSelfAssessmentDraft(
    partId: string,
    payload: Omit<SelfAssessmentDraft, 'version' | 'revision' | 'partId' | 'savedAt'>,
  ): Promise<boolean> {
    if (!isPersistableSubmission(payload.submission)
      || !isPersistableSelfAssessment(payload.assessment)
      || (payload.selectedPoints !== null && !Number.isFinite(payload.selectedPoints))
      || (payload.grading !== null && !isGrading(payload.grading))
      || !Number.isFinite(payload.indeterminateMax)) {
      throw new TypeError('Self-assessment draft is malformed');
    }
    return enqueueSessionPersistence(async () => {
      const currentItem = items.value[index.value];
      if (phase.value !== 'running' || !currentItem || currentItem.partId !== partId) return false;
      if (graded.value.some((record) => record.partId === partId)) return false;
      const comparable = {
        submission: payload.submission,
        assessment: payload.assessment,
        selectedPoints: payload.selectedPoints,
        grading: payload.grading,
        indeterminate: payload.indeterminate,
        indeterminateMax: payload.indeterminateMax,
      };
      const previous = selfAssessmentDraft.value;
      if (previous && previous.partId === partId && JSON.stringify({
        submission: previous.submission,
        assessment: previous.assessment,
        selectedPoints: previous.selectedPoints,
        grading: previous.grading,
        indeterminate: previous.indeterminate,
        indeterminateMax: previous.indeterminateMax,
      }) === JSON.stringify(comparable)) return true;
      const owner = await ensureSessionIdentity();
      if (!activeProfileCanAccessSession() || !sessionStorageKey) return false;
      const revision = draftRevision.value + 1;
      const savedAt = new Date().toISOString();
      const draft: SelfAssessmentDraft = {
        version: 1,
        revision,
        partId,
        submission: cloneSubmission(payload.submission),
        assessment: {
          ...payload.assessment,
          ...(payload.assessment.criteriaMet
            ? { criteriaMet: [...payload.assessment.criteriaMet] }
            : {}),
        },
        selectedPoints: payload.selectedPoints,
        grading: payload.grading,
        indeterminate: payload.indeterminate,
        indeterminateMax: payload.indeterminateMax,
        savedAt,
      };
      const snapshot = buildPersistedSession(owner, graded.value, savedAt, { revision, draft });
      try {
        const committed = await commitSessionSnapshot(sessionStorageKey, snapshot, false);
        draftRevision.value = committed.draftRevision ?? revision;
        selfAssessmentDraft.value = committed.selfAssessmentDraft
          ? cloneSelfAssessmentDraft(committed.selfAssessmentDraft)
          : undefined;
        lastActivityAt.value = committed.savedAt;
        sessionIdentityDurable.value = true;
        return selfAssessmentDraft.value?.partId === partId;
      } catch {
        warning.value = 'Die Selbstbewertung konnte lokal nicht gespeichert werden.';
        return false;
      }
    });
  }

  /**
   * Manual grading from the ever-present menu (supplement §1.2 — manual
   * always wins). If the part was answered THIS session, the override
   * replaces the auto advance (rebased on the pre-answer snapshot);
   * otherwise it acts as a standalone review event.
   */
  async function overrideGrading(partId: string, grading: Grading): Promise<void> {
    const progress = useProgressStore();
    const input: Parameters<typeof progress.setGrading>[0] = { partId, grading };
    const durableReview = graded.value.find((record) => record.partId === partId);
    if (durableReview && !durableReview.gradingBaseCaptured && !preAnswerFsrs.has(partId)) {
      throw new Error('Diese ältere Bewertung kann nicht sicher als derselbe Versuch ersetzt werden.');
    }
    if (durableReview?.gradingBaseCaptured || preAnswerFsrs.has(partId)) {
      input.baseFsrs = durableReview?.gradingBaseCaptured
        ? durableReview.preAnswerFsrs
        : preAnswerFsrs.get(partId);
      input.replaceCurrentReview = true;
    }
    await progress.setGrading(input);
  }

  /** Set of partIds already graded this session (drives the session rail). */
  const gradedPartIds = computed(() => new Set(graded.value.map((g) => g.partId)));

  /**
   * Jump to a not-yet-graded session item (session rail). Graded parts are
   * not revisitable — re-answering would advance FSRS twice for one attempt.
   */
  function jumpTo(i: number): void {
    if (phase.value !== 'running') return;
    const item = items.value[i];
    if (!item || i === index.value) return;
    if (gradedPartIds.value.has(item.partId)) return;
    index.value = i;
    partShownAt.value = Date.now();
    void persistSession();
  }

  /** Advance to the next UNGRADED item (cyclic — jumping may leave gaps);
   *  the session completes only when every item has been graded. */
  function next(): void {
    const n = items.value.length;
    if (graded.value.length >= n) {
      phase.value = 'summary';
      void endOfSession();
      return;
    }
    for (let step = 1; step <= n; step++) {
      const i = (index.value + step) % n;
      if (!gradedPartIds.value.has(items.value[i]!.partId)) {
        index.value = i;
        partShownAt.value = Date.now();
        void persistSession();
        return;
      }
    }
    phase.value = 'summary';
    void endOfSession();
  }

  /** Remove the short-lived answer snapshot before any deliberate navigation. */
  async function closeCurrentReview(): Promise<void> {
    const review = currentReview.value;
    if (review?.pendingSubmission || review?.correctionDraft) {
      const closedAt = new Date().toISOString();
      const nextGraded = graded.value.map((candidate) => {
        if (candidate.clientAttemptId !== review.clientAttemptId) return candidate;
        const {
          pendingSubmission: _privateAnswer,
          correctionDraft: _correctionDraft,
          ...withoutPrivateAnswer
        } = candidate;
        return cloneGradedRecord({ ...withoutPrivateAnswer, correctionClosedAt: closedAt });
      });
      const owner = await ensureSessionIdentity();
      const key = sessionStorageKey;
      if (!key) throw new Error('Practice session has no durable storage identity');
      const snapshot = buildPersistedSession(owner, nextGraded, closedAt);
      const committed = await enqueueSessionPersistence(() => commitSessionSnapshot(key, snapshot, false));
      graded.value = committed.graded.map(cloneGradedRecord);
      lastActivityAt.value = committed.savedAt;
    }
  }

  /** Leave review only after removing its short-lived local answer snapshot. */
  async function completeReviewAndNext(): Promise<void> {
    await closeCurrentReview();
    next();
  }

  async function syncSessionProgress(): Promise<void> {
    const progress = useProgressStore();
    if (!sessionResolvedOwnerId || !progress.isActiveAccountOwner(sessionResolvedOwnerId)) return;
    await progress.syncNow({ quiet: true });
    await progress.flushAttemptOutbox();
  }

  async function endOfSession(): Promise<void> {
    await clearPersistedSession();
    await syncSessionProgress();
  }

  function toAttemptRecord(g: GradedRecord): QueuedAttempt {
    return {
      clientAttemptId: g.clientAttemptId,
      contentSource: contentSource.value,
      ...(contentId.value ? { contentId: contentId.value } : {}),
      questionId: g.questionId,
      partId: g.partId,
      correct: g.result.correct,
      awardedPoints: g.result.awardedPoints,
      elapsedMs: g.elapsedMs,
      gradedAt: g.gradedAt,
    };
  }

  async function finishSession(): Promise<void> {
    await persistSession();
    await syncSessionProgress();
  }

  async function hydratePersistedSession(
    snapshot: PersistedPracticeSession,
    source: CoreSourcePreference,
    expectedContentId?: string,
  ): Promise<boolean> {
    assertContentLoadCurrent();
    if (!activeProfileCanAccessSession()) {
      throw new DOMException('The saved practice belongs to another account.', 'AbortError');
    }
    const exact = expectedContentId !== undefined;
    pendingExactRestore = exact ? { snapshot, source, contentId: expectedContentId } : undefined;
    phase.value = 'loading';
    sessionIdentityDurable.value = false;
    error.value = undefined;
    warning.value = undefined;
    // If the restore fails the user lands on the error screen, whose retry
    // must keep the exact question ids. Recommending a new smart programme
    // here would silently replace the interrupted one.
    lastRequest.value = {
      kind: 'questions',
      source,
      ids: [...new Set(snapshot.items.map((item) => item.questionId))],
      ...(expectedContentId ? { contentId: expectedContentId } : {}),
    };
    try {
      await bindSessionContent(source, expectedContentId);
      await fetchQuestions(snapshot.items.map((item) => item.questionId));
      const identitySeed = [
        snapshot.owner?.localProfileId ?? snapshot.owner?.userId ?? 'unknown',
        snapshot.contentId ?? 'unknown',
        snapshot.savedAt,
      ].join('|');
      const validItems = normalizeSessionItems(snapshot.items.filter((item) => {
        const question = questions.value.get(item.questionId);
        return question?.parts.some((part) => part.id === item.partId && part.answer);
      }), identitySeed);
      if (exact && validItems.length !== snapshot.items.length) {
        throw new Error('Die Auswahl konnte nicht vollständig geladen werden. Bitte erneut versuchen.');
      }
      if (validItems.length === 0) {
        if (pendingUnprovenancedSession?.snapshot === snapshot) {
          enterFailClosedError(
            new Error('Keine der gespeicherten Aufgaben ist in der aktuell gewählten Bank verfügbar.'),
          );
          return true;
        }
        phase.value = 'idle';
        await clearPersistedSession();
        return false;
      }

      const validPartIds = new Set(validItems.map((item) => item.partId));
      const seenGraded = new Set<string>();
      let restoredGraded = snapshot.graded.filter((record) => {
        if (!validPartIds.has(record.partId) || seenGraded.has(record.partId)) return false;
        seenGraded.add(record.partId);
        return true;
      });
      // Older clients could commit learning evidence before the session. Keep
      // recovering that correction, and repair a missing first event only for
      // the current unresolved review; never repopulate evicted history.
      const learningProfile = sessionOwner?.localProfileId;
      if (learningProfile) {
        restoredGraded = await Promise.all(restoredGraded.map(async (record) => {
          if (record.correctionOutcome) return record;
          let evidence: LearningEvent | undefined;
          try {
            evidence = record.partId === snapshot.items[snapshot.index]?.partId
              && correctionStillOpen(record)
              ? await recoverLearningEvent(learningProfile, record, snapshot)
              : await learningEventStore.event(learningProfile, record.clientAttemptId);
          } catch {
            warning.value = 'Die Korrektur-Empfehlung konnte lokal nicht gespeichert werden.';
          }
          return evidence?.correctionOutcome
            ? cloneGradedRecord({ ...record, correctionOutcome: evidence.correctionOutcome })
            : record;
        }));
      }
      assertContentLoadCurrent();
      if (!activeProfileCanAccessSession()) throw new Error('Das Konto wurde während des Ladens gewechselt.');
      const savedItem = snapshot.items[snapshot.index];
      let restoredIndex = savedItem
        ? validItems.findIndex((item) =>
            item.questionId === savedItem.questionId && item.partId === savedItem.partId)
        : 0;
      if (restoredIndex < 0) restoredIndex = 0;

      items.value = validItems.map(cloneSessionItem);
      origin.value = snapshot.origin;
      lastActivityAt.value = snapshot.savedAt;
      graded.value = restoredGraded;
      draftRevision.value = snapshot.draftRevision ?? 0;
      selfAssessmentDraft.value = snapshot.selfAssessmentDraft
        && snapshot.selfAssessmentDraft.partId === validItems[restoredIndex]?.partId
        && !restoredGraded.some((record) => record.partId === snapshot.selfAssessmentDraft?.partId)
        ? cloneSelfAssessmentDraft(snapshot.selfAssessmentDraft)
        : undefined;
      pendingGradeRecords.clear();
      preAnswerFsrs.clear();
      for (const record of restoredGraded) {
        if (record.gradingBaseCaptured) preAnswerFsrs.set(record.partId, record.preAnswerFsrs);
      }
      const savedReview = restoredGraded.find((record) =>
        record.partId === validItems[restoredIndex]!.partId);
      const restoreReviewedState = correctionStillOpen(savedReview);
      if (restoredGraded.length >= validItems.length && !restoreReviewedState) {
        index.value = restoredIndex;
        phase.value = 'summary';
        pendingUnprovenancedSession = undefined;
        await clearPersistedSession();
        assertContentLoadCurrent();
        pendingExactRestore = undefined;
        return true;
      }

      if (seenGraded.has(validItems[restoredIndex]!.partId) && !restoreReviewedState) {
        for (let step = 1; step <= validItems.length; step++) {
          const candidate = (restoredIndex + step) % validItems.length;
          if (!seenGraded.has(validItems[candidate]!.partId)) {
            restoredIndex = candidate;
            break;
          }
        }
      }
      index.value = restoredIndex;
      phase.value = 'running';
      partShownAt.value = Date.now();
      const saved = await persistSession({
        replaceExisting: pendingUnprovenancedSession?.snapshot === snapshot,
      });
      assertContentLoadCurrent();
      if (!saved) throw new Error('Das laufende Programm konnte lokal nicht gespeichert werden.');
      pendingUnprovenancedSession = undefined;
      pendingExactRestore = undefined;
      return true;
    } catch (e) {
      assertContentLoadCurrent();
      sessionIdentityDurable.value = false;
      enterFailClosedError(e);
      return true;
    }
  }

  /**
   * Rehydrate an interrupted program from IndexedDB. Questions themselves are
   * restored through the existing cache-first loader, keeping the snapshot
   * small and usable offline.
   *
   * `want` restricts what may be resumed. „Programm üben" passes 'smart', so
   * a half-finished hand-picked set from the Aufgaben list is NOT what the
   * user gets handed back — they asked for today's programme. Nothing is lost
   * by declining: every grade is written to the archive as it happens, only
   * the position inside that ad-hoc set goes away.
   */
  function restoreSession(want?: SessionOrigin, expectedPreparedId?: string): Promise<boolean> {
    return runContentLoad(() => restoreSessionNow(want, expectedPreparedId));
  }

  async function restoreSessionNow(want?: SessionOrigin, expectedPreparedId?: string): Promise<boolean> {
    if (expectedPreparedId !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(expectedPreparedId)) return false;
      // A new in-flight/failed preparation is never another route's session.
      if (phase.value === 'loading' || pendingUnprovenancedSession || phase.value === 'provenance-choice') return false;
      if (phase.value === 'running' && items.value[0]?.clientAttemptId !== expectedPreparedId) return false;
    }
    if (phase.value === 'loading') return true;
    if (phase.value === 'provenance-choice' || (phase.value === 'error' && pendingUnprovenancedSession)) {
      const requestedOwner = await useProgressStore().captureAttemptOwner();
      assertContentLoadCurrent();
      return profileCanAccessSession(requiredOwnerProfile(requestedOwner));
    }
    if (phase.value === 'running') {
      const requestedOwner = await useProgressStore().captureAttemptOwner();
      assertContentLoadCurrent();
      if (expectedPreparedId && items.value[0]?.clientAttemptId !== expectedPreparedId) return false;
      const requestedProfile = requiredOwnerProfile(requestedOwner);
      const ownerProfile = sessionOwner?.localProfileId;
      if (
        !isLocalProfileId(ownerProfile)
        || !profileCanAccessSession(requestedProfile)
      ) {
        // Keep the old snapshot untouched. The caller may now start a session
        // in the newly active profile without seeing or deleting this one.
        return false;
      }
      if (ownerProfile !== requestedProfile) sessionResolvedOwnerId = requestedOwner.userId;
      if (want && origin.value !== want) return false;
      // A just-prepared handoff already owns verified text and blob URLs.
      // Rebinding here used to revoke those URLs before the first render.
      if (!expectedPreparedId) {
        try {
          await bindSessionContent(contentSource.value, contentId.value, true);
        } catch (e) {
          enterFailClosedError(e);
          return true;
        }
      }
      if (expectedPreparedId && !sessionIdentityDurable.value) return false;
      // A PWA can stay open for days; the live session ages the same way a
      // persisted one does.
      if (!isResumable(origin.value, lastActivityAt.value, new Date())) {
        await clearPersistedSession();
        assertContentLoadCurrent();
        return false;
      }
      if (
        current.value
        && gradedPartIds.value.has(current.value.item.partId)
        && !correctionStillOpen(currentReview.value)
      ) {
        next();
        await sessionPersistenceTail;
        assertContentLoadCurrent();
      }
      return true;
    }
    const requestedOwner = await useProgressStore().captureAttemptOwner();
    assertContentLoadCurrent();
    await sessionPersistenceTail;
    assertContentLoadCurrent();
    const located = await locatePersistedSession(requestedOwner);
    assertContentLoadCurrent();
    if (!located) return false;
    const { snapshot } = located;
    // Reload/back may resume this exact saved selection, but never a newer
    // programme or the arbitrary old snapshot left by a failed preparation.
    if (expectedPreparedId && (snapshot.origin !== 'manual'
      || snapshot.items[0]?.clientAttemptId !== expectedPreparedId
      || !hasExactContentProvenance(snapshot))) return false;
    setSessionIdentity(snapshot.owner!, {
      key: located.key,
      resolvedOwnerId: located.resolvedOwnerId,
    });
    if (snapshot.items.length === 0) {
      await clearPersistedSession();
      return false;
    }
    if (want && snapshot.origin !== want) return false;
    if (!isResumable(snapshot.origin, snapshot.savedAt, new Date())) {
      await clearPersistedSession();
      return false;
    }
    if (!hasExactContentProvenance(snapshot)) {
      pendingUnprovenancedSession = { snapshot };
      lastRequest.value = undefined;
      phase.value = 'provenance-choice';
      error.value = undefined;
      warning.value = undefined;
      return true;
    }
    return hydratePersistedSession(snapshot, snapshot.contentSource, snapshot.contentId);
  }

  /** Explicit opt-in required for v2/v3 or incomplete-v4 snapshots. */
  function resumeWithCurrentContent(): Promise<void> {
    return runContentLoad(resumeWithCurrentContentNow);
  }

  async function resumeWithCurrentContentNow(): Promise<void> {
    const pending = pendingUnprovenancedSession;
    if (!pending) return;
    const source = pending.selectedSource ?? useAppStore().coreEndpointSource;
    pending.selectedSource = source;
    await hydratePersistedSession(pending.snapshot, source);
  }

  /**
   * Redo whatever the user last asked for. „Erneut versuchen" used to call the
   * view's `start()`, which re-reads the URL — and the Aufgaben bulk handoff
   * puts no ids in the URL, so a retry silently swapped the hand-picked set
   * for today's programme.
   */
  function retry(): Promise<void> {
    return runContentLoad(retryNow);
  }

  async function retryNow(): Promise<void> {
    if (pendingExactRestore) {
      const pending = pendingExactRestore;
      await hydratePersistedSession(pending.snapshot, pending.source, pending.contentId);
      return;
    }
    if (pendingUnprovenancedSession?.selectedSource) {
      await hydratePersistedSession(
        pendingUnprovenancedSession.snapshot,
        pendingUnprovenancedSession.selectedSource,
      );
      return;
    }
    const request = lastRequest.value;
    if (!request) {
      await startSmartNow();
      return;
    }
    if (request.kind === 'questions') {
      await startQuestionsNow(request.ids, request.source, request.contentId);
    }
    else await startSmartNow(request.opts, request.source, request.contentId);
  }

  function abort(): void {
    contentLoadEpoch += 1;
    pendingExactRestore = undefined;
    phase.value = 'idle';
    warning.value = undefined;
    items.value = [];
    questions.value = new Map();
    origin.value = 'smart';
    graded.value = [];
    selfAssessmentDraft.value = undefined;
    draftRevision.value = 0;
    pendingGradeRecords.clear();
    preAnswerFsrs.clear();
    index.value = 0;
    void clearPersistedSession();
    sessionOwner = undefined;
    sessionStorageKey = undefined;
    sessionResolvedOwnerId = undefined;
    sessionCoreClient = undefined;
    contentMode.value = 'current';
    sessionManifest = undefined;
    sessionManifestUnavailable = false;
    sessionLearningRecommendations = false;
    sessionIdentityDurable.value = false;
    pendingUnprovenancedSession = undefined;
    contentId.value = undefined;
    revokePinnedAssets();
    useAppStore().releaseCoreContentPin();
  }

  function suspendContentPin(): void {
    useAppStore().releaseCoreContentPin();
  }

  /**
   * Figures in a running programme resolve through the same source-pinned
   * client as its JSON. This deliberately does not depend on App's live Core
   * preference, which another Desktop window may change mid-session.
   */
  function assetUrl(src: string): string {
    if ((contentSource.value === 'remote' || contentMode.value === 'revision') && sessionCoreClient) {
      const pinned = pinnedAssetUrls.get(assetKey(src));
      if (pinned) return pinned;
      // Never fall through to a mutable Remote Core after the session has
      // been bound. Missing snapshot entries render broken-but-safe instead
      // of silently mixing revisions.
      warning.value = 'Eine Aufgabengrafik fehlt im überprüften lokalen Abbild.';
      return 'data:,';
    }
    return (sessionCoreClient ?? useAppStore().coreClient).assetUrl(src);
  }

  return {
    items,
    questions,
    index,
    origin,
    graded,
    retry,
    phase,
    error,
    warning,
    sessionIdentityDurable,
    sessionAccessible,
    contentSource,
    contentId,
    contentMode,
    total,
    current,
    currentReview,
    currentSelfAssessmentDraft,
    currentAnswerDraft,
    currentPendingGrading,
    summary,
    gradedPartIds,
    jumpTo,
    startSmart,
    startQuestions,
    startPrepared,
    recordGraded,
    recordCorrection,
    saveCorrectionDraft,
    recordDiagnosis,
    recordHintLevel,
    recordCachedAiHelp,
    recordAiHelp,
    recordCachedAiAssessment,
    saveAnswerDraft,
    savePendingGrading,
    saveSelfAssessmentDraft,
    overrideGrading,
    next,
    completeReviewAndNext,
    closeCurrentReview,
    finishSession,
    restoreSession,
    resumeWithCurrentContent,
    suspendContentPin,
    assetUrl,
    abort,
  };
});
