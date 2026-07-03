/**
 * Local archive store — the single durable progress document.
 *
 * PROFILE SEMANTICS: the local archive is ONE shared document regardless of
 * login state (contract: guest progress merges into an account via sync, and
 * login/logout must NEVER clear it). It therefore lives under one fixed key.
 * The profileId constructor arg is kept for future flexibility only; it does
 * not change the storage location today.
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import type { CompetencyEntry, LocalArchive, PartEntry } from '../model/archive.js';
import type { Verdict } from '../grading/types.js';
import type { RecommendUserState } from '../api/types.js';
import { archiveChecksum } from '../sync/checksum.js';
import { advanceFsrs, verdictToRating, updateMastery } from '../fsrs/index.js';

/** Single shared archive document — see profile semantics above. */
const ARCHIVE_KEY = 'current';

export interface ApplyGradeInput {
  partId: string;
  /** Competency codes attached to the graded part (each gets a mastery update). */
  competencyCodes: string[];
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number;
  now: Date;
}

export class ArchiveStore {
  constructor(
    private readonly storage: StoragePort,
    /** Reserved for future multi-profile support; unused today (see above). */
    private readonly profileId: string = 'guest',
  ) {}

  async load(): Promise<LocalArchive> {
    const stored = await this.storage.get<LocalArchive>(STORAGE.archive, ARCHIVE_KEY);
    // Fresh objects so callers can never mutate a shared default.
    return stored ?? { content: { perPart: [], perCompetency: [] }, baseVersion: 0 };
  }

  async save(archive: LocalArchive): Promise<void> {
    await this.storage.set(STORAGE.archive, ARCHIVE_KEY, archive);
  }

  // NOTE: no reset()/clear() on purpose — login/logout must never clear the
  // local archive (iron rule); the only way content leaves is via sync merge.

  /**
   * Record one graded part: advance that part's FSRS state, stamp lastResult,
   * and update the mastery EMA of every attached competency. All timestamps
   * come from the injected `now` (grading itself is pure and clock-free).
   */
  async applyGrade(input: ApplyGradeInput): Promise<LocalArchive> {
    const archive = await this.load();
    const nowIso = input.now.toISOString();

    const perPart = [...archive.content.perPart];
    const partIdx = perPart.findIndex((p) => p.partId === input.partId);
    const prev = partIdx >= 0 ? perPart[partIdx] : undefined;
    const entry: PartEntry = {
      partId: input.partId,
      fsrs: advanceFsrs(prev?.fsrs, verdictToRating(input.verdict), input.now),
      lastResult: {
        correct: input.verdict === 'correct',
        awardedPoints: input.awardedPoints,
        gradedAt: nowIso,
      },
      updatedAt: nowIso,
    };
    if (partIdx >= 0) perPart[partIdx] = entry;
    else perPart.push(entry);

    const ratio = input.maxPoints > 0 ? input.awardedPoints / input.maxPoints : 0;
    const perCompetency = [...archive.content.perCompetency];
    for (const code of input.competencyCodes) {
      const compIdx = perCompetency.findIndex((c) => c.code === code);
      const prevMastery = compIdx >= 0 ? perCompetency[compIdx]?.mastery : undefined;
      const next: CompetencyEntry = {
        code,
        mastery: updateMastery(prevMastery, ratio),
        updatedAt: nowIso,
      };
      if (compIdx >= 0) perCompetency[compIdx] = next;
      else perCompetency.push(next);
    }

    const updated: LocalArchive = {
      content: { perPart, perCompetency },
      baseVersion: archive.baseVersion,
    };
    await this.save(updated);
    return updated;
  }

  /** Server-identical checksum of the current local content. */
  async checksum(): Promise<string> {
    const archive = await this.load();
    return archiveChecksum(archive.content);
  }

  /** Projection sent to POST /content/recommend (anonymous — no ids beyond parts). */
  async toUserState(): Promise<RecommendUserState> {
    const archive = await this.load();
    return {
      perPart: archive.content.perPart.map((p) => ({ partId: p.partId, fsrs: p.fsrs })),
      perCompetency: archive.content.perCompetency.map((c) => ({ code: c.code, mastery: c.mastery })),
    };
  }

  /** Dashboard counts: parts due for review now, and total parts ever practiced. */
  async dueCounts(now: Date): Promise<{ due: number; practiced: number }> {
    const archive = await this.load();
    const nowMs = now.getTime();
    const due = archive.content.perPart.filter((p) => new Date(p.fsrs.due).getTime() <= nowMs).length;
    return { due, practiced: archive.content.perPart.length };
  }
}
