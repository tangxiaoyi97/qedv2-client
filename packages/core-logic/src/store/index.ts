export {
  ArchiveStore,
  ARCHIVE_STORAGE_KEY,
  prepareArchiveGrade,
  prepareLocalArchive,
} from './archive-store.js';
export type { ApplyGradeInput, ApplyGradeResult, SetGradingInput } from './archive-store.js';
export { ConfigStore } from './config-store.js';
export type { Theme } from './config-store.js';
export {
  AuthStore,
  AUTH_SESSION_STORAGE_KEY,
  DEFAULT_EXPIRY_WINDOW_MS,
  parseAuthSession,
} from './auth-store.js';
export type { AuthSession, AuthSessionInspection, AuthSessionSnapshot } from './auth-store.js';
export { QuestionCache, questionContentHash } from './question-cache.js';
export {
  HistoryLog,
  HISTORY_EVENT_ROW_PREFIX,
  HISTORY_STORAGE_KEY,
  historyEventRowKey,
  parseStoredHistoryEvent,
  prepareHistoryAppend,
  prepareHistoryLog,
  prepareStoredHistoryEvent,
} from './history-log.js';
export type { HistoryEntry, StoredHistoryEvent } from './history-log.js';
export {
  AttemptOutbox,
  ATTEMPT_OUTBOX_CORRUPT_ROW_PREFIX,
  ATTEMPT_OUTBOX_STORAGE_KEY,
  ATTEMPT_OUTBOX_ROW_PREFIX,
  AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  GUEST_ATTEMPT_OWNER,
  GUEST_CLAIM_STORAGE_KEY,
  attemptOutboxRowKey,
  prepareAttemptEnqueue,
  prepareGuestClaim,
  preparePendingAttempts,
  resolveAttemptOwner,
  resolveAttemptOwnership,
} from './attempt-outbox.js';
export type {
  AttemptOwnerSnapshot,
  CorruptAttemptInventoryRow,
  CorruptAttemptJournalRow,
  GuestClaimRoute,
  GuestClaimState,
  LegacyAccountRecoveryBinding,
  PendingAttempt,
  QueuedAttempt,
  ResolvedAttemptOwnership,
} from './attempt-outbox.js';
export { LocalGradeCommitStore } from './local-grade-commit.js';
export type {
  LocalGradeCommitInput,
  LocalGradeCommitResult,
  LocalGradeSessionMutation,
} from './local-grade-commit.js';
export { SyncMutationJournal, SYNC_MUTATION_LEGACY_KEY_PREFIX } from './sync-mutation-journal.js';
export type {
  SyncMutationIntent,
  SyncMutationOperation,
  SyncMutationRecord,
  SyncMutationResolveIntent,
  SyncMutationScope,
  SyncMutationSyncIntent,
} from './sync-mutation-journal.js';
export {
  LocalProfileStore,
  LOCAL_PROFILE_STATE_KEY,
  archiveStorageKey,
  guestLocalProfileId,
  historyStorageKey,
  isLocalProfileId,
  parseLocalProfileState,
  resolveLocalProfileId,
  userLocalProfileId,
} from './local-profile-store.js';
export type { LocalProfileId, LocalProfileState } from './local-profile-store.js';
export { LocalRecoveryStore } from './local-recovery-store.js';
export type {
  LegacyPendingAccountRecovery,
  LocalRecoveryBlockReason,
  LocalRecoveryExport,
  LocalRecoveryInventory,
  LocalRecoveryProfileInventory,
} from './local-recovery-store.js';
export {
  RegistrationJournal,
  RegistrationIntentConflictError,
  REGISTRATION_INTENT_STORAGE_KEY,
} from './registration-journal.js';
export type { RegistrationIntent } from './registration-journal.js';
export * from './ai-cache.js';
