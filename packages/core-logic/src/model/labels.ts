/**
 * German display strings and option vocabularies for the domain enums.
 *
 * These live here, next to the types they describe, because every shell needs
 * the same words and the same lists. Scattered across views they drifted: the
 * grading labels existed in three places, the verdict labels in six, and the
 * Aufgaben URL parser validated against a copy of the filter dialog's option
 * list — so a value the dialog offered could be silently dropped on reload.
 */
import type { ExamPart, Term } from './question.js';
import type { Grading, GradingOrUnseen } from './archive.js';
import type { Verdict } from '../grading/types.js';

/* --- vocabularies: what a value is allowed to be ---------------------------- */

export const TERMS: readonly Term[] = [
  'haupttermin',
  'nebentermin-1',
  'nebentermin-2',
  'herbsttermin',
  'wintertermin',
] as const;

export const EXAM_PARTS: readonly ExamPart[] = ['t1', 't2'] as const;

/** Selectable states. `unseen` is the absence of a record, never a choice. */
export const SELECTABLE_GRADINGS: readonly Grading[] = [
  'good',
  'careless',
  'meh',
  'baffled',
  'excluded',
] as const;

/** Everything a part can be filtered by, `unseen` included. */
export const GRADINGS: readonly GradingOrUnseen[] = [...SELECTABLE_GRADINGS, 'unseen'] as const;

/** Grundkompetenz categories, in the order the SRDP lists them. */
export const CATEGORY_ORDER = ['AG', 'FA', 'AN', 'WS'] as const;

export type CategoryCode = (typeof CATEGORY_ORDER)[number];

/* --- labels: how a value is written --------------------------------------- */

export const TERM_LABELS: Record<Term, string> = {
  haupttermin: 'Haupttermin',
  'nebentermin-1': 'Nebentermin 1',
  'nebentermin-2': 'Nebentermin 2',
  herbsttermin: 'Herbsttermin',
  wintertermin: 'Wintertermin',
};

export const TEIL_LABELS: Record<ExamPart, string> = {
  t1: 'Teil 1',
  t2: 'Teil 2',
};

/** Mastery states (grading supplement §1.5). */
export const GRADING_LABELS: Record<GradingOrUnseen, string> = {
  good: 'Gut',
  careless: 'Schlampigkeitsfehler',
  meh: 'Halb verstanden',
  baffled: 'Keine Ahnung',
  excluded: 'Ausgeschlossen',
  unseen: 'Neu',
};

/**
 * What choosing a mastery state means for future scheduling, in the user's
 * words. Lived in three copies — the grading popover, the self-assessment
 * option list and the settings help text — which is one copy per place the
 * wording could drift.
 */
export const GRADING_HINTS: Record<Grading, string> = {
  good: 'Gemeistert',
  careless: 'Eigentlich gekonnt',
  meh: 'Bald wiederholen',
  baffled: 'Von vorn',
  excluded: 'Nie wieder üben',
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  correct: 'Richtig',
  partial: 'Teilweise richtig',
  incorrect: 'Falsch',
};

/** Short forms for places where the full label does not fit (stat columns). */
export const VERDICT_LABELS_SHORT: Record<Verdict, string> = {
  correct: 'Richtig',
  partial: 'Teilweise',
  incorrect: 'Falsch',
};
