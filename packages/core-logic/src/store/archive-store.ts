/**
 * Local archive store — the single durable progress document.
 *
 * PROFILE SEMANTICS: each guest generation and cloud account has an isolated
 * local archive. Ordinary login only selects that account's profile; explicit
 * invite registration is the sole path that may claim a guest profile.
 *
 * GRADING SEMANTICS (grading supplement §1): every FSRS advance is driven by
 * a Grading value. Objective grading auto-derives it (correct→good,
 * partial→meh, incorrect→baffled); a manual pick always overrides — within
 * the same answer event that means REPLACING the auto advance, so
 * applyGrade returns the pre-advance FSRS snapshot for setGrading to rebase
 * on. `excluded` freezes the part completely (§1.4).
 */
import { hasAtomicStorage, STORAGE } from '../ports/index.js';
import type {
  AtomicStoragePort,
  StorageAddress,
  StoragePort,
  StorageVersionedEntry,
} from '../ports/index.js';
import { canonicalizeArchive, normNum } from '../model/archive.js';
import type {
  CompetencyEntry,
  FsrsState,
  Grading,
  LocalArchive,
  PartEntry,
} from '../model/archive.js';
import type { Verdict } from '../grading/types.js';
import type { RecommendUserState } from '../api/types.js';
import { archiveChecksum } from '../sync/checksum.js';
import {
  archiveStorageKey,
  LOCAL_PROFILE_STATE_KEY,
  parseLocalProfileState,
  resolveLocalProfileId,
  type LocalProfileId,
} from './local-profile-store.js';
import {
  advanceFsrsForGrading,
  verdictToAutoGrading,
  placeholderFsrs,
  isPartDue,
  isPracticed,
  updateMastery,
  EXCLUDED_DUE_SENTINEL,
} from '../fsrs/index.js';

/** Legacy pre-2.2 archive key, retained for one-time migration. */
export const ARCHIVE_STORAGE_KEY = 'current';

const PROFILE_STATE_ADDRESS = {
  collection: STORAGE.app,
  key: LOCAL_PROFILE_STATE_KEY,
} as const;
const MAX_PROFILE_CAS_ATTEMPTS = 6;

interface ProfileArchiveSnapshot {
  state: StorageVersionedEntry;
  archive: StorageVersionedEntry;
  archiveAddress: StorageAddress;
}

export interface ApplyGradeInput {
  partId: string;
  /** Competency codes attached to the graded part (each gets a mastery update). */
  competencyCodes: string[];
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number;
  now: Date;
}

export interface ApplyGradeResult {
  archive: LocalArchive;
  /**
   * The grading this event actually recorded. Normally the auto-derived one;
   * for a part frozen as `excluded` it stays `excluded`, because answering
   * must not thaw it (§1.4).
   */
  grading: Grading;
  /**
   * FSRS state BEFORE this grade advanced it (undefined = first contact).
   * Manual re-grading of the same answer event rebases on this snapshot so
   * the auto advance is replaced, not stacked.
   */
  previousFsrs: FsrsState | undefined;
}

/** Pure migration used by both ordinary writes and atomic grade commits. */
export function prepareLocalArchive(stored: LocalArchive | undefined): LocalArchive {
  if (!stored) return { content: { perPart: [], perCompetency: [] }, baseVersion: 0 };
  const needsMigration = stored.content.perPart.some(
    (part) => (part as Partial<PartEntry>).grading === undefined
      || (part as Partial<PartEntry>).starred === undefined,
  );
  if (!needsMigration) return stored;
  const content = canonicalizeArchive(stored.content);
  for (const part of content.perPart) {
    if (part.grading === null && part.lastResult) {
      part.grading = part.lastResult.correct
        ? 'good'
        : part.lastResult.awardedPoints > 0
          ? 'meh'
          : 'baffled';
    }
  }
  return { content, baseVersion: stored.baseVersion };
}

function sameArchive(left: LocalArchive, right: LocalArchive): boolean {
  return left.baseVersion === right.baseVersion
    && archiveChecksum(left.content) === archiveChecksum(right.content);
}

/** Compute one grade without writing; safe to retry after a CAS conflict. */
export function prepareArchiveGrade(
  stored: LocalArchive | undefined,
  input: ApplyGradeInput,
): ApplyGradeResult {
  const archive = prepareLocalArchive(stored);
  const nowIso = input.now.toISOString();
  const grading = verdictToAutoGrading(input.verdict);

  const perPart = [...archive.content.perPart];
  const partIdx = perPart.findIndex((part) => part.partId === input.partId);
  const prev = partIdx >= 0 ? perPart[partIdx] : undefined;
  const previousFsrs = prev && isPracticed(prev) ? prev.fsrs : undefined;
  const frozen = prev?.grading === 'excluded';
  const entry: PartEntry = {
    partId: input.partId,
    grading: frozen ? 'excluded' : grading,
    starred: prev?.starred ?? false,
    fsrs: frozen && prev ? prev.fsrs : advanceFsrsForGrading(previousFsrs, grading, input.now),
    lastResult: {
      correct: input.verdict === 'correct',
      awardedPoints: normNum(input.awardedPoints),
      gradedAt: nowIso,
    },
    updatedAt: nowIso,
  };
  if (partIdx >= 0) perPart[partIdx] = entry;
  else perPart.push(entry);

  const ratio = input.maxPoints > 0 ? input.awardedPoints / input.maxPoints : 0;
  const perCompetency = [...archive.content.perCompetency];
  for (const code of input.competencyCodes) {
    const compIdx = perCompetency.findIndex((competency) => competency.code === code);
    const prevMastery = compIdx >= 0 ? perCompetency[compIdx]?.mastery : undefined;
    const next: CompetencyEntry = {
      code,
      mastery: updateMastery(prevMastery, ratio),
      updatedAt: nowIso,
    };
    if (compIdx >= 0) perCompetency[compIdx] = next;
    else perCompetency.push(next);
  }

  return {
    archive: {
      content: { perPart, perCompetency },
      baseVersion: archive.baseVersion,
    },
    grading: entry.grading ?? grading,
    previousFsrs,
  };
}

export interface SetGradingInput {
  partId: string;
  grading: Grading;
  now: Date;
  /**
   * When re-grading the same answer event: the pre-answer FSRS snapshot
   * (from ApplyGradeResult.previousFsrs) to rebase on. Omit for standalone
   * manual grading (list view, later sessions) — then the advance starts
   * from the current state.
   */
  baseFsrs?: FsrsState | undefined;
}

/** Pure manual grading mutation, reused after every CAS retry. */
export function prepareArchiveGrading(
  stored: LocalArchive | undefined,
  input: SetGradingInput,
): LocalArchive {
  const archive = prepareLocalArchive(stored);
  const nowIso = input.now.toISOString();

  const perPart = [...archive.content.perPart];
  const partIdx = perPart.findIndex((p) => p.partId === input.partId);
  const prev = partIdx >= 0 ? perPart[partIdx] : undefined;

  let fsrs: FsrsState;
  if (input.grading === 'excluded') {
    fsrs = input.baseFsrs ?? prev?.fsrs ?? placeholderFsrs(input.now);
  } else {
    const base = input.baseFsrs !== undefined
      ? input.baseFsrs
      : prev && isPracticed(prev)
        ? prev.fsrs
        : undefined;
    fsrs = advanceFsrsForGrading(base, input.grading, input.now);
  }

  const entry: PartEntry = {
    partId: input.partId,
    grading: input.grading,
    starred: prev?.starred ?? false,
    fsrs,
    updatedAt: nowIso,
  };
  if (prev?.lastResult) entry.lastResult = prev.lastResult;
  if (partIdx >= 0) perPart[partIdx] = entry;
  else perPart.push(entry);

  return {
    content: { perPart, perCompetency: archive.content.perCompetency },
    baseVersion: archive.baseVersion,
  };
}

/** Pure bookmark mutation, reused after every CAS retry. */
export function prepareArchiveStar(
  stored: LocalArchive | undefined,
  partId: string,
  starred: boolean,
  now: Date,
): LocalArchive {
  const archive = prepareLocalArchive(stored);
  const nowIso = now.toISOString();
  const perPart = [...archive.content.perPart];
  const partIdx = perPart.findIndex((p) => p.partId === partId);
  const prev = partIdx >= 0 ? perPart[partIdx] : undefined;
  const entry: PartEntry = prev
    ? { ...prev, starred, updatedAt: nowIso }
    : {
        partId,
        grading: null,
        starred,
        fsrs: placeholderFsrs(now),
        updatedAt: nowIso,
      };
  if (partIdx >= 0) perPart[partIdx] = entry;
  else perPart.push(entry);

  return {
    content: { perPart, perCompetency: archive.content.perCompetency },
    baseVersion: archive.baseVersion,
  };
}

export class ArchiveStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly profileId?: LocalProfileId | (() => LocalProfileId | undefined),
  ) {}

  /** Capture the renderer's profile once; durable routes decide every retry. */
  private requestedProfile(): LocalProfileId | undefined {
    return typeof this.profileId === 'function' ? this.profileId() : this.profileId;
  }

  private async readProfileSnapshot(
    storage: AtomicStoragePort,
    profileId: LocalProfileId,
  ): Promise<ProfileArchiveSnapshot> {
    for (let attempt = 0; attempt < MAX_PROFILE_CAS_ATTEMPTS; attempt += 1) {
      const [stateHint] = await storage.readBatch([PROFILE_STATE_ADDRESS]);
      if (!stateHint) throw new Error('Local profile state read returned no entry');
      const hintedState = parseLocalProfileState(stateHint.value);
      if (!hintedState) throw new Error('Local profile state is missing');
      const archiveAddress = {
        collection: STORAGE.archive,
        key: archiveStorageKey(resolveLocalProfileId(hintedState, profileId)),
      } as const;
      const snapshots = await storage.readBatch([PROFILE_STATE_ADDRESS, archiveAddress]);
      if (snapshots.length !== 2 || !snapshots[0] || !snapshots[1]) {
        throw new Error('Profile archive read returned an incomplete snapshot');
      }
      const durableState = parseLocalProfileState(snapshots[0].value);
      if (!durableState) throw new Error('Local profile state is missing');
      const durableKey = archiveStorageKey(resolveLocalProfileId(durableState, profileId));
      if (durableKey !== archiveAddress.key) continue;
      return {
        state: snapshots[0],
        archive: snapshots[1],
        archiveAddress,
      };
    }
    throw new Error('Local profile routing changed too often');
  }

  async load(): Promise<LocalArchive> {
    const profileId = this.requestedProfile();
    if (!profileId) {
      const stored = await this.storage.get<LocalArchive>(
        STORAGE.archive,
        ARCHIVE_STORAGE_KEY,
      );
      return prepareLocalArchive(stored);
    }
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required for profile-bound archive access');
    }
    const snapshot = await this.readProfileSnapshot(this.storage, profileId);
    return prepareLocalArchive(snapshot.archive.value as LocalArchive | undefined);
  }

  /**
   * Migration: archives written before the grading upgrade lack
   * grading/starred and used key-omitted lastReview. canonicalizeArchive
   * fills the shape; the grading itself is derived from lastResult so
   * previously practiced parts keep meaningful dots (correct→good,
   * partial→meh, wrong→baffled) instead of appearing unseen.
   */
  async save(archive: LocalArchive): Promise<void> {
    const profileId = this.requestedProfile();
    if (!profileId) {
      await this.storage.set(STORAGE.archive, ARCHIVE_STORAGE_KEY, archive);
      return;
    }
    if (!hasAtomicStorage(this.storage)) {
      throw new Error('Atomic storage is required for profile-bound archive access');
    }
    for (let attempt = 0; attempt < MAX_PROFILE_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await this.readProfileSnapshot(this.storage, profileId);
      const committed = await this.storage.commitBatch({
        ifRevisions: [
          { ...PROFILE_STATE_ADDRESS, revision: snapshot.state.revision },
          { ...snapshot.archiveAddress, revision: snapshot.archive.revision },
        ],
        mutations: [{
          ...snapshot.archiveAddress,
          operation: 'set',
          value: archive,
        }],
      });
      if (committed.committed) return;
    }
    throw new Error('Archive profile changed too often to save safely.');
  }

  private async mutateWithCas<Result>(
    prepare: (stored: LocalArchive | undefined) => { archive: LocalArchive; result: Result },
  ): Promise<Result> {
    const profileId = this.requestedProfile();
    if (!hasAtomicStorage(this.storage)) {
      if (profileId) {
        throw new Error('Atomic storage is required for profile-bound archive access');
      }
      const prepared = prepare(await this.load());
      await this.save(prepared.archive);
      return prepared.result;
    }
    if (profileId) {
      for (let attempt = 0; attempt < MAX_PROFILE_CAS_ATTEMPTS; attempt += 1) {
        const snapshot = await this.readProfileSnapshot(this.storage, profileId);
        const prepared = prepare(snapshot.archive.value as LocalArchive | undefined);
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...PROFILE_STATE_ADDRESS, revision: snapshot.state.revision },
            { ...snapshot.archiveAddress, revision: snapshot.archive.revision },
          ],
          mutations: [{
            ...snapshot.archiveAddress,
            operation: 'set',
            value: prepared.archive,
          }],
        });
        if (committed.committed) return prepared.result;
      }
      throw new Error('Archive profile changed too often to commit safely.');
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const [entry] = await this.storage.readBatch([{
        collection: STORAGE.archive,
        key: ARCHIVE_STORAGE_KEY,
      }]);
      if (!entry) throw new Error('Archive revision read returned no entry.');
      const prepared = prepare(entry.value as LocalArchive | undefined);
      const committed = await this.storage.commitBatch({
        ifRevisions: [{
          collection: STORAGE.archive,
          key: ARCHIVE_STORAGE_KEY,
          revision: entry.revision,
        }],
        mutations: [{
          operation: 'set',
          collection: STORAGE.archive,
          key: ARCHIVE_STORAGE_KEY,
          value: prepared.archive,
        }],
      });
      if (committed.committed) return prepared.result;
    }
    throw new Error('Archive changed too often to commit safely.');
  }

  /** Optimistic sync commit that cannot overwrite a newer tab/window write. */
  async saveIfUnchanged(expected: LocalArchive, next: LocalArchive): Promise<boolean> {
    const profileId = this.requestedProfile();
    if (!hasAtomicStorage(this.storage)) {
      if (profileId) {
        throw new Error('Atomic storage is required for profile-bound archive access');
      }
      const current = await this.load();
      if (!sameArchive(current, expected)) return false;
      await this.save(next);
      return true;
    }
    if (profileId) {
      for (let attempt = 0; attempt < MAX_PROFILE_CAS_ATTEMPTS; attempt += 1) {
        const snapshot = await this.readProfileSnapshot(this.storage, profileId);
        const current = prepareLocalArchive(
          snapshot.archive.value as LocalArchive | undefined,
        );
        if (!sameArchive(current, expected)) return false;
        const committed = await this.storage.commitBatch({
          ifRevisions: [
            { ...PROFILE_STATE_ADDRESS, revision: snapshot.state.revision },
            { ...snapshot.archiveAddress, revision: snapshot.archive.revision },
          ],
          mutations: [{
            ...snapshot.archiveAddress,
            operation: 'set',
            value: next,
          }],
        });
        if (committed.committed) return true;
      }
      return false;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const [entry] = await this.storage.readBatch([{
        collection: STORAGE.archive,
        key: ARCHIVE_STORAGE_KEY,
      }]);
      if (!entry) throw new Error('Archive revision read returned no entry.');
      const current = prepareLocalArchive(entry.value as LocalArchive | undefined);
      if (!sameArchive(current, expected)) return false;
      const committed = await this.storage.commitBatch({
        ifRevisions: [{
          collection: STORAGE.archive,
          key: ARCHIVE_STORAGE_KEY,
          revision: entry.revision,
        }],
        mutations: [{
          operation: 'set',
          collection: STORAGE.archive,
          key: ARCHIVE_STORAGE_KEY,
          value: next,
        }],
      });
      if (committed.committed) return true;
    }
    return false;
  }

  // NOTE: no reset()/clear() on purpose — login/logout must never clear the
  // local archive (iron rule); the only way content leaves is via sync merge.

  /**
   * Record one graded part: derive the auto grading from the verdict,
   * advance FSRS through the grading map, stamp lastResult, and update the
   * mastery EMA of every attached competency. All timestamps come from the
   * injected `now` (grading itself is pure and clock-free).
   */
  async applyGrade(input: ApplyGradeInput): Promise<ApplyGradeResult> {
    return this.mutateWithCas((stored) => {
      const result = prepareArchiveGrade(stored, input);
      return { archive: result.archive, result };
    });
  }

  /**
   * Manual grading (supplement §1.2 — always wins over the auto default).
   *
   * - With `baseFsrs` (same answer event): the advance is recomputed FROM
   *   THAT SNAPSHOT, replacing the auto advance entirely.
   * - Without: a standalone review event — advance from the current state.
   * - `excluded`: freeze — grading is stored, FSRS state kept at `baseFsrs`
   *   when given (same answer event), otherwise at the current one.
   * - Grading a part with no entry creates one (counts as a first review,
   *   except excluded, which creates a frozen reps-0 placeholder).
   */
  async setGrading(input: SetGradingInput): Promise<LocalArchive> {
    return this.mutateWithCas((stored) => {
      const archive = prepareArchiveGrading(stored, input);
      return { archive, result: archive };
    });
  }

  /** Toggle the bookmark (independent of grading — supplement §2). */
  async setStarred(partId: string, starred: boolean, now: Date): Promise<LocalArchive> {
    return this.mutateWithCas((stored) => {
      const archive = prepareArchiveStar(stored, partId, starred, now);
      return { archive, result: archive };
    });
  }

  /** Server-identical checksum of the current local content. */
  async checksum(): Promise<string> {
    const archive = await this.load();
    return archiveChecksum(archive.content);
  }

  /**
   * Projection sent to POST /content/recommend.
   *
   * - reps-0 placeholders (starred/excluded without practice) are DROPPED —
   *   for core they must still count as unseen…
   * - …EXCEPT excluded placeholders, which are projected with a far-future
   *   due so core never offers them as new NOR as due review (supplement
   *   §1.4 — excluded is frozen out of every recommendation). Practiced
   *   excluded parts get the same far-future due.
   */
  async toUserState(): Promise<RecommendUserState> {
    const archive = await this.load();
    const perPart: RecommendUserState['perPart'] = [];
    for (const p of archive.content.perPart) {
      if (p.grading === 'excluded') {
        perPart.push({ partId: p.partId, fsrs: { ...p.fsrs, due: EXCLUDED_DUE_SENTINEL } });
      } else if (isPracticed(p)) {
        perPart.push({ partId: p.partId, fsrs: p.fsrs });
      }
    }
    return {
      perPart,
      perCompetency: archive.content.perCompetency.map((c) => ({ code: c.code, mastery: c.mastery })),
    };
  }

  /** Set of excluded partIds — for filtering recommendation results. */
  async excludedPartIds(): Promise<Set<string>> {
    const archive = await this.load();
    return new Set(archive.content.perPart.filter((p) => p.grading === 'excluded').map((p) => p.partId));
  }

  /** Dashboard counts: parts due for review now, and total parts practiced. */
  async dueCounts(now: Date): Promise<{ due: number; practiced: number }> {
    const archive = await this.load();
    const due = archive.content.perPart.filter((p) => isPartDue(p, now)).length;
    const practiced = archive.content.perPart.filter((p) => isPracticed(p)).length;
    return { due, practiced };
  }
}
